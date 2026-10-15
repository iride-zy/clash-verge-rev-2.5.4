pub mod config;
mod stun;

use crate::{config::Config, core::handle::Handle};
use anyhow::{Context, Result, bail, ensure};
use reqwest::{Client, Method, Proxy};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{Arc, LazyLock, Weak},
    time::Duration,
};
use tokio::sync::Mutex;

// Selection belongs only to private probe groups. Hold through TCP and UDP so concurrent
// batches cannot move an outlet halfway through a measurement. Independent provider
// inlets can run together; the registry lock is held only while obtaining their lock.
static PROBES: LazyLock<Mutex<HashMap<String, Weak<Mutex<()>>>>> = LazyLock::new(Mutex::default);

async fn probe_lock(group: &str) -> Arc<Mutex<()>> {
    let mut probes = PROBES.lock().await;
    probes.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = probes.get(group).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    probes.insert(group.to_owned(), Arc::downgrade(&lock));
    lock
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub ip: Option<String>,
    pub location: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub entry: Endpoint,
    pub exit: Endpoint,
    pub nat: stun::NatResult,
}

async fn endpoint(provider: Option<&str>) -> Result<config::ProbeEndpoint> {
    let runtime = Config::runtime().await;
    let snapshot = runtime.latest_arc();
    config::endpoint(snapshot.config.as_ref().context("no active runtime")?, provider)
}

pub async fn check(name: &str, provider: Option<&str>, timeout_ms: u64, udp: bool) -> Result<Report> {
    let expected = endpoint(provider).await?;
    let lock = probe_lock(&expected.group).await;
    let _guard = lock.lock().await;
    ensure!(
        endpoint(provider).await? == expected,
        "profile changed while waiting for detection"
    );
    let config::ProbeEndpoint {
        group,
        port,
        credentials,
    } = &expected;
    let mihomo = Handle::mihomo();
    close_probe_connections(group).await?;
    mihomo.select_node_for_group(group, name).await?;
    let duration = Duration::from_millis(timeout_ms.clamp(3000, 30000));
    let mut proxy = Proxy::all(format!("http://127.0.0.1:{port}"))?;
    if let Some((username, password)) = credentials {
        proxy = proxy.basic_auth(username, password);
    }
    let client = Client::builder()
        .no_proxy()
        .proxy(proxy)
        .timeout(duration)
        .connect_timeout(duration)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("clash-verge-node-diagnostics")
        .build()?;

    // TCP and UDP share only the selected private outlet, not connections or observations.
    let tcp = tcp_endpoints(&client, group);
    let nat = async {
        if udp {
            match stun::check(*port, timeout_ms, credentials.as_ref()).await {
                Ok(result) => result,
                Err(error) => stun::NatResult::unknown(&format!("{error:#}")),
            }
        } else {
            stun::NatResult {
                kind: "unsupported",
                estimated: false,
                mapped_address: None,
                detail: Some("Node does not support UDP".into()),
            }
        }
    };
    let ((entry, exit), nat) = tokio::join!(tcp, nat);
    // SOCKS5 control closure alone does not remove Mihomo's UDP NAT-table entry.
    // Remove only our private connections before allowing the next node to use this inlet.
    drop(client);
    close_probe_connections(group).await?;
    ensure!(
        endpoint(provider).await? == expected,
        "profile changed during detection"
    );
    Ok(Report { entry, exit, nat })
}

async fn tcp_endpoints(client: &Client, group: &str) -> (Endpoint, Endpoint) {
    // Keep the client (and its pooled connection) alive while reading the actual entry.
    let exit = match geo(client, None).await {
        Ok(info) => info,
        Err(error) => Endpoint {
            error: Some(error.to_string()),
            ..Default::default()
        },
    };
    let mut entry = match entry_ip(group).await {
        Ok(ip) => Endpoint {
            ip: Some(ip.to_string()),
            ..Default::default()
        },
        Err(error) => Endpoint {
            error: Some(error.to_string()),
            ..Default::default()
        },
    };
    if let Some(ip) = &entry.ip {
        match geo(client, Some(ip)).await {
            Ok(info) => entry.location = info.location,
            Err(error) => entry.error = Some(error.to_string()),
        }
    }
    (entry, exit)
}

async fn geo(client: &Client, ip: Option<&str>) -> Result<Endpoint> {
    let url = ip.map_or_else(
        || "https://api.ip.sb/geoip".to_owned(),
        |ip| format!("https://api.ip.sb/geoip/{ip}"),
    );
    let mut response = client.get(url).send().await?.error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(bytes.len() + chunk.len() <= 32768, "geolocation response too large");
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes)?;
    let address: IpAddr = value["ip"]
        .as_str()
        .context("geolocation service did not return an IP")?
        .parse()?;
    if let Some(expected) = ip {
        ensure!(address == expected.parse::<IpAddr>()?, "geolocation IP mismatch");
    }
    let location = ["country", "region", "city"]
        .iter()
        .filter_map(|key| value[*key].as_str())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" / ");
    Ok(Endpoint {
        ip: Some(address.to_string()),
        location: (!location.is_empty()).then_some(location),
        error: None,
    })
}

async fn entry_ip(group: &str) -> Result<IpAddr> {
    let value: Value = Handle::mihomo()
        .load_ctx()
        .build_request(Method::GET, "/connections")?
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    connection_entry_ip(&value, group)
}

fn connection_entry_ip(value: &Value, group: &str) -> Result<IpAddr> {
    for connection in value["connections"].as_array().into_iter().flatten() {
        let metadata = &connection["metadata"];
        if metadata["inboundName"].as_str() != Some(group) && metadata["specialProxy"].as_str() != Some(group) {
            continue;
        }
        // STUN now runs alongside geolocation. Its UDP route need not use the same
        // entry as HTTP, so only the actual TCP connection can supply this endpoint.
        if !metadata["network"].as_str().is_some_and(|network| network.eq_ignore_ascii_case("tcp")) {
            continue;
        }
        if let Some(address) = metadata["remoteDestination"].as_str() {
            if let Ok(ip) = address.parse::<IpAddr>() {
                return Ok(ip);
            }
            if let Ok(addr) = address.parse::<std::net::SocketAddr>() {
                return Ok(addr.ip());
            }
        }
    }
    bail!("core did not expose an actual entry IP for this connection")
}

async fn close_probe_connections(group: &str) -> Result<()> {
    let mihomo = Handle::mihomo();
    let value: Value = mihomo
        .load_ctx()
        .build_request(Method::GET, "/connections")?
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    for connection in value["connections"].as_array().into_iter().flatten() {
        let metadata = &connection["metadata"];
        if metadata["inboundName"].as_str() == Some(group) || metadata["specialProxy"].as_str() == Some(group) {
            if let Some(id) = connection["id"].as_str() {
                mihomo.close_connection(id).await?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn same_inlet_is_serialized_without_blocking_other_providers() {
        let first = probe_lock("test-provider-one").await;
        let same = probe_lock("test-provider-one").await;
        let other = probe_lock("test-provider-two").await;
        assert!(Arc::ptr_eq(&first, &same));
        let _guard = first.lock().await;
        assert!(same.try_lock().is_err());
        assert!(other.try_lock().is_ok());
    }

    #[test]
    fn entry_uses_only_the_private_http_connection_when_udp_runs_concurrently() -> Result<()> {
        let connections = json!({"connections": [
            {"metadata": {"network": "tcp", "inboundName": "user", "remoteDestination": "192.0.2.1"}},
            {"metadata": {"network": "udp", "inboundName": "probe", "remoteDestination": "192.0.2.2"}},
            {"metadata": {"network": "tcp", "specialProxy": "probe", "remoteDestination": "[2001:db8::3]:443"}}
        ]});
        assert_eq!(connection_entry_ip(&connections, "probe")?, "2001:db8::3".parse::<IpAddr>()?);
        assert!(connection_entry_ip(&connections, "missing").is_err());
        Ok(())
    }
}
