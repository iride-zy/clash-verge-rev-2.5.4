pub mod config;
mod stun;

use crate::{config::Config, core::handle::Handle};
use anyhow::{Context, Result, bail, ensure};
use reqwest::{Client, Method, Proxy};
use serde::Serialize;
use serde_json::Value;
use std::{net::IpAddr, time::Duration};
use tokio::sync::Mutex;

// Selection belongs only to private probe groups. Hold through TCP and UDP so concurrent
// batches cannot move an outlet halfway through a measurement.
static PROBE: Mutex<()> = Mutex::const_new(());

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

async fn endpoint(provider: Option<&str>) -> Result<(String, u16)> {
    let runtime = Config::runtime().await;
    let snapshot = runtime.latest_arc();
    config::endpoint(snapshot.config.as_ref().context("no active runtime")?, provider)
}

pub async fn check(name: &str, provider: Option<&str>, timeout_ms: u64, udp: bool) -> Result<Report> {
    let expected = endpoint(provider).await?;
    let _guard = PROBE.lock().await;
    ensure!(
        endpoint(provider).await? == expected,
        "profile changed while waiting for detection"
    );
    let (group, port) = &expected;
    let mihomo = Handle::mihomo();
    close_probe_connections(group).await?;
    mihomo.select_node_for_group(group, name).await?;
    let duration = Duration::from_millis(timeout_ms.clamp(3000, 30000));
    let client = Client::builder()
        .no_proxy()
        .proxy(Proxy::all(format!("http://127.0.0.1:{port}"))?)
        .timeout(duration)
        .connect_timeout(duration)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("clash-verge-node-diagnostics")
        .build()?;

    // Keep the client (and its pooled connection) alive while reading the actual entry.
    let exit = match geo(&client, None).await {
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
        match geo(&client, Some(ip)).await {
            Ok(info) => entry.location = info.location,
            Err(error) => entry.error = Some(error.to_string()),
        }
    }
    let nat = if udp {
        match stun::check(*port, timeout_ms).await {
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
    };
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
    for connection in value["connections"].as_array().into_iter().flatten() {
        let metadata = &connection["metadata"];
        if metadata["inboundName"].as_str() != Some(group) && metadata["specialProxy"].as_str() != Some(group) {
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
