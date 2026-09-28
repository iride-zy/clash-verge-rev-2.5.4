//! Private inbounds use the running core's original proxy objects, including provider overrides.
use anyhow::{Context, Result, bail};
use serde_yaml_ng::{Mapping, Value};
use std::net::{TcpListener, UdpSocket};

pub const PREFIX: &str = "__verge_probe_";

// Deliberately neither Debug nor Serialize: proxy credentials stay in the backend.
#[derive(PartialEq, Eq)]
pub struct ProbeEndpoint {
    pub group: String,
    pub port: u16,
    pub credentials: Option<(String, String)>,
}

pub fn install(mut config: Mapping) -> Result<Mapping> {
    let mut nonce = [0_u8; 8];
    getrandom::fill(&mut nonce).map_err(|e| anyhow::anyhow!("probe nonce: {e}"))?;
    let nonce = u64::from_ne_bytes(nonce);
    let mut sources = vec![None];
    if let Some(providers) = config.get("proxy-providers").and_then(Value::as_mapping) {
        sources.extend(providers.keys().filter_map(Value::as_str).map(|s| Some(s.to_owned())));
    }
    let names: Vec<Value> = config
        .get("proxies")
        .and_then(Value::as_sequence)
        .into_iter()
        .flatten()
        .filter_map(|p| p.get("name").cloned())
        .collect();
    let mut groups = config
        .get("proxy-groups")
        .and_then(Value::as_sequence)
        .cloned()
        .unwrap_or_default();
    let mut listeners = config
        .get("listeners")
        .and_then(Value::as_sequence)
        .cloned()
        .unwrap_or_default();
    // Keep reservations until every port is chosen; TCP and UDP must share the same port.
    let mut reservations = Vec::new();
    for (index, provider) in sources.into_iter().enumerate() {
        if provider.is_none() && names.is_empty() {
            continue;
        }
        let name = format!("{PREFIX}{nonce:016x}_{index}");
        let (tcp, udp) = reserve_port(&config)?;
        let port = tcp.local_addr()?.port();
        reservations.push((tcp, udp));
        let mut group = Mapping::new();
        group.insert("name".into(), name.clone().into());
        group.insert("type".into(), "select".into());
        group.insert("hidden".into(), true.into());
        if let Some(provider) = provider {
            group.insert("use".into(), Value::Sequence(vec![provider.into()]));
        } else {
            group.insert("proxies".into(), Value::Sequence(names.clone()));
        }
        groups.push(Value::Mapping(group));
        // Omit users so Mihomo applies the normal ports' global authentication policy.
        let listener = serde_yaml_ng::from_str::<Value>(&format!(
            "name: {name}\ntype: mixed\nlisten: 127.0.0.1\nport: {port}\nudp: true\nproxy: {name}\n"
        ))?;
        listeners.push(listener);
    }
    config.insert("proxy-groups".into(), Value::Sequence(groups));
    config.insert("listeners".into(), Value::Sequence(listeners));
    Ok(config)
}

fn reserve_port(config: &Mapping) -> Result<(TcpListener, UdpSocket)> {
    for _ in 0..16 {
        let tcp = TcpListener::bind(("127.0.0.1", 0)).context("reserve diagnostic TCP port")?;
        let port = tcp.local_addr()?.port();
        let configured = ["port", "socks-port", "mixed-port", "redir-port", "tproxy-port"]
            .iter().filter_map(|key| config.get(*key))
            .chain(config.get("listeners").and_then(Value::as_sequence).into_iter().flatten().filter_map(|l| l.get("port")))
            .any(|value| {
                if value.as_u64() == Some(u64::from(port)) { return true; }
                value.as_str().is_some_and(|ports| ports.split(',').any(|range| {
                    let range = range.trim();
                    if let Some((start, end)) = range.split_once('-') {
                        matches!((start.parse::<u16>(), end.parse::<u16>()), (Ok(start), Ok(end)) if (start..=end).contains(&port))
                    } else { range.parse::<u16>().ok() == Some(port) }
                }))
            });
        if configured {
            continue;
        }
        if let Ok(udp) = UdpSocket::bind(tcp.local_addr()?) {
            return Ok((tcp, udp));
        }
    }
    bail!("could not reserve diagnostic TCP/UDP port")
}

pub fn endpoint(config: &Mapping, provider: Option<&str>) -> Result<ProbeEndpoint> {
    let groups = config
        .get("proxy-groups")
        .and_then(Value::as_sequence)
        .context("missing proxy groups")?;
    let group = groups
        .iter()
        .find(|g| {
            g.get("name")
                .and_then(Value::as_str)
                .is_some_and(|n| n.starts_with(PREFIX))
                && g.get("use")
                    .and_then(Value::as_sequence)
                    .and_then(|s| s.first())
                    .and_then(Value::as_str)
                    == provider
        })
        .context("diagnostic inlet unavailable; reload the profile")?;
    let name = group
        .get("name")
        .and_then(Value::as_str)
        .context("missing probe group")?;
    let port = config
        .get("listeners")
        .and_then(Value::as_sequence)
        .into_iter()
        .flatten()
        .find(|l| l.get("name").and_then(Value::as_str) == Some(name))
        .and_then(|l| l.get("port"))
        .and_then(Value::as_u64)
        .context("missing probe port")?;
    // Mihomo splits authentication entries at the first colon and ignores entries without one.
    // Use the last entry so a later password for the same username cannot invalidate our choice.
    let credentials = config
        .get("authentication")
        .and_then(Value::as_sequence)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|entry| entry.split_once(':'))
        .next_back()
        .map(|(username, password)| (username.to_owned(), password.to_owned()));
    Ok(ProbeEndpoint {
        group: name.to_owned(),
        port: u16::try_from(port)?,
        credentials,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_listener_inherits_global_authentication() -> Result<()> {
        let config: Mapping = serde_yaml_ng::from_str(
            "proxies: [{name: example, type: direct}]\nauthentication: ['user:old', 'user:new:password']\nskip-auth-prefixes: ['127.0.0.1/32']\n",
        )?;
        let installed = install(config.clone())?;
        assert_eq!(installed.get("authentication"), config.get("authentication"));
        assert_eq!(installed.get("skip-auth-prefixes"), config.get("skip-auth-prefixes"));
        let listeners = installed.get("listeners").and_then(Value::as_sequence).unwrap();
        assert_eq!(listeners.len(), 1);
        assert!(listeners[0].get("users").is_none());
        let endpoint = endpoint(&installed, None)?;
        assert_eq!(endpoint.credentials, Some(("user".into(), "new:password".into())));
        Ok(())
    }

    #[test]
    fn diagnostic_listener_supports_no_global_credentials() -> Result<()> {
        let config = install(serde_yaml_ng::from_str("proxies: [{name: example, type: direct}]\n")?)?;
        assert!(endpoint(&config, None)?.credentials.is_none());
        Ok(())
    }
}
