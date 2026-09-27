//! STUN candidates use independent SOCKS5 UDP associations in the running Mihomo core.
//! Partial observations may yield an estimated type; silence alone never proves blocked UDP.
use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, UdpSocket},
    task::JoinSet,
    time::{Instant, timeout_at},
};

const COOKIE: [u8; 4] = [0x21, 0x12, 0xa4, 0x42];
// Public STUN services are candidates, not assumed to be reachable or support discovery.
// See stunprotocol.org and github.com/emercoin/emercoin/blob/master/src/gen-stun-list.c.
const SERVERS: [&str; 3] = [
    "stunserver2025.stunprotocol.org",
    "stun.miwifi.com",
    "stun.hot-chilli.net",
];
const RETRY_DELAYS_MS: [u64; 3] = [400, 800, 1200];
// The first datagram also triggers DNS resolution and the proxy's UDP session setup.
const INITIAL_RETRY_DELAYS_MS: [u64; 4] = [500, 1000, 2000, 4000];

pub fn detection_timeout(timeout_ms: u64) -> Duration {
    // Baseline, two filtering tests, two alternate targets, then baseline verification.
    // Filtering timeouts are part of a successful test, not a failed latency probe.
    let minimum_ms =
        INITIAL_RETRY_DELAYS_MS.iter().sum::<u64>() + RETRY_DELAYS_MS.iter().sum::<u64>() * 5 + 3000;
    Duration::from_millis(timeout_ms.clamp(minimum_ms, 30000))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NatResult {
    pub kind: &'static str,
    pub estimated: bool,
    pub mapped_address: Option<String>,
    pub detail: Option<String>,
}

impl NatResult {
    pub fn unknown(detail: &str) -> Self {
        Self {
            kind: "unknown",
            estimated: false,
            mapped_address: None,
            detail: Some(detail.into()),
        }
    }
}

struct Binding {
    mapped: SocketAddr,
    other: Option<SocketAddr>,
}

fn address(bytes: &[u8], xor: bool, transaction: &[u8; 12]) -> Result<SocketAddr> {
    ensure!(bytes.len() >= 4, "truncated STUN address");
    let mut port = u16::from_be_bytes([bytes[2], bytes[3]]);
    if xor {
        port ^= 0x2112;
    }
    let size = match bytes[1] {
        1 => 4,
        2 => 16,
        _ => bail!("invalid STUN address family"),
    };
    ensure!(bytes.len() == 4 + size, "invalid STUN address length");
    let mut ip = [0_u8; 16];
    ip[..size].copy_from_slice(&bytes[4..]);
    if xor {
        let mask: Vec<_> = COOKIE.into_iter().chain(transaction.iter().copied()).collect();
        for index in 0..size {
            ip[index] ^= mask[index];
        }
    }
    let ip = if size == 4 {
        IpAddr::V4(Ipv4Addr::new(ip[0], ip[1], ip[2], ip[3]))
    } else {
        IpAddr::V6(Ipv6Addr::from(ip))
    };
    ensure!(
        !ip.is_unspecified() && !ip.is_multicast() && port != 0,
        "invalid STUN endpoint"
    );
    Ok(SocketAddr::new(ip, port))
}

fn parse(bytes: &[u8], transaction: &[u8; 12]) -> Result<Binding> {
    ensure!(
        bytes.len() >= 20 && bytes[4..8] == COOKIE && bytes[8..20] == *transaction,
        "unrelated STUN packet"
    );
    ensure!(
        bytes[..2] == [1, 1],
        "STUN server returned an error or unsupported response"
    );
    let length = u16::from_be_bytes([bytes[2], bytes[3]]) as usize;
    ensure!(
        length % 4 == 0 && bytes.len() == 20 + length,
        "invalid STUN message length"
    );
    let mut offset = 20;
    let mut mapped = None;
    let mut other = None;
    while offset < bytes.len() {
        ensure!(offset + 4 <= bytes.len(), "truncated STUN attribute");
        let kind = u16::from_be_bytes([bytes[offset], bytes[offset + 1]]);
        let length = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]) as usize;
        offset += 4;
        ensure!(offset + length <= bytes.len(), "truncated STUN value");
        let value = &bytes[offset..offset + length];
        match kind {
            0x0020 => mapped = Some(address(value, true, transaction)?),
            0x0001 if mapped.is_none() => mapped = Some(address(value, false, transaction)?),
            0x802c => other = Some(address(value, false, transaction)?),
            0x0005 if other.is_none() => other = Some(address(value, false, transaction)?),
            _ => {}
        }
        offset += (length + 3) & !3;
    }
    ensure!(offset == bytes.len(), "invalid STUN padding");
    Ok(Binding {
        mapped: mapped.context("missing STUN mapped address")?,
        other,
    })
}

fn socks_address(address: SocketAddr) -> Vec<u8> {
    let mut bytes = Vec::new();
    match address.ip() {
        IpAddr::V4(ip) => {
            bytes.push(1);
            bytes.extend_from_slice(&ip.octets());
        }
        IpAddr::V6(ip) => {
            bytes.push(4);
            bytes.extend_from_slice(&ip.octets());
        }
    }
    bytes.extend_from_slice(&address.port().to_be_bytes());
    bytes
}

fn unwrap_packet(bytes: &[u8]) -> Result<(SocketAddr, &[u8])> {
    ensure!(
        bytes.len() >= 4 && bytes[..3] == [0, 0, 0],
        "fragmented or invalid SOCKS5 UDP packet"
    );
    let size = match bytes[3] {
        1 => 4,
        4 => 16,
        _ => bail!("SOCKS5 reply did not contain an IP"),
    };
    ensure!(bytes.len() >= 6 + size, "truncated SOCKS5 UDP packet");
    let ip = if size == 4 {
        IpAddr::V4(Ipv4Addr::new(bytes[4], bytes[5], bytes[6], bytes[7]))
    } else {
        let mut ip = [0; 16];
        ip.copy_from_slice(&bytes[4..20]);
        IpAddr::V6(Ipv6Addr::from(ip))
    };
    let port = u16::from_be_bytes([bytes[4 + size], bytes[5 + size]]);
    Ok((SocketAddr::new(ip, port), &bytes[6 + size..]))
}

async fn exchange(
    socket: &UdpSocket,
    target: &[u8],
    change: u32,
    expected_source: Option<SocketAddr>,
) -> Result<Option<(Binding, SocketAddr)>> {
    exchange_with_retries(socket, target, change, expected_source, &RETRY_DELAYS_MS).await
}

fn classify(
    first: SocketAddr,
    filtering: Option<&'static str>,
    alternate: Option<SocketAddr>,
    baseline: Option<SocketAddr>,
) -> NatResult {
    let stable = baseline == Some(first);
    let (kind, evidence) = if alternate.is_some_and(|mapped| mapped != first) {
        ("symmetric", "Different destinations produced different public UDP mappings")
    } else {
        match filtering {
            Some("full-cone") => ("full-cone", "Received a reply from the requested alternate IP and port"),
            Some("restricted-cone") => (
                "restricted-cone",
                "Received a reply from the requested alternate port, but not from the alternate IP and port",
            ),
            Some("port-restricted-cone") if alternate.is_some() || baseline.is_some() => (
                "port-restricted-cone",
                "Both changed-source probes timed out, while an ordinary binding request still received a reply",
            ),
            _ => (
                "unknown",
                "Initial UDP binding succeeded, but subsequent evidence is insufficient to classify NAT",
            ),
        }
    };
    let estimated = kind != "unknown"
        && (!stable || alternate.is_none() || matches!(kind, "restricted-cone" | "port-restricted-cone"));
    let mut details = vec![evidence.to_owned()];
    if alternate.is_none() {
        details.push("Alternate mapping check unavailable; retained any observed filtering evidence".into());
    }
    if !stable {
        details.push(if baseline.is_some() {
            "Baseline mapping changed; mapping differences may reflect a changing path".into()
        } else {
            "Baseline recheck unavailable; retained earlier observations".into()
        });
    }
    details.push(if estimated {
        "Estimated proxy-path NAT type; packet loss or server behavior can affect the result".into()
    } else {
        "Observed proxy-path behavior".into()
    });
    NatResult {
        kind,
        estimated,
        mapped_address: Some(first.to_string()),
        detail: Some(details.join(". ")),
    }
}

// Optional checks refine the result but must not erase evidence from successful checks.
fn observation(
    result: Result<Option<(Binding, SocketAddr)>>,
    stage: &str,
    notes: &mut Vec<String>,
) -> Option<Binding> {
    match result {
        Ok(Some((binding, _))) => Some(binding),
        Ok(None) => {
            notes.push(format!("{stage}: no response after retries"));
            None
        }
        Err(error) => {
            notes.push(format!("{stage}: {error:#}"));
            None
        }
    }
}

async fn exchange_with_retries(
    socket: &UdpSocket,
    target: &[u8],
    change: u32,
    expected_source: Option<SocketAddr>,
    retry_delays_ms: &[u64],
) -> Result<Option<(Binding, SocketAddr)>> {
    let mut transaction = [0; 12];
    getrandom::fill(&mut transaction).map_err(|e| anyhow::anyhow!("STUN transaction: {e}"))?;
    let mut packet = vec![0, 0, 0];
    packet.extend_from_slice(target);
    packet.extend_from_slice(&[0, 1, 0, if change == 0 { 0 } else { 8 }]);
    packet.extend_from_slice(&COOKIE);
    packet.extend_from_slice(&transaction);
    if change != 0 {
        packet.extend_from_slice(&[0, 3, 0, 4]);
        packet.extend_from_slice(&change.to_be_bytes());
    }
    let mut buffer = [0; 2048];
    let mut invalid_packet = None;
    for &wait in retry_delays_ms {
        socket.send(&packet).await?;
        let until = Instant::now() + Duration::from_millis(wait);
        loop {
            let count = match timeout_at(until, socket.recv(&mut buffer)).await {
                Ok(result) => result?,
                Err(_) => break,
            };
            let (source, message) = match unwrap_packet(&buffer[..count]) {
                Ok(packet) => packet,
                Err(error) => {
                    invalid_packet = Some(error);
                    continue;
                }
            };
            if expected_source.is_some_and(|expected| source != expected) {
                continue;
            }
            if message.len() < 20 || message[8..20] != transaction {
                continue;
            }
            return Ok(Some((parse(message, &transaction)?, source)));
        }
    }
    if let Some(error) = invalid_packet {
        return Err(error.context("received UDP replies but could not decode the SOCKS5 envelope"));
    }
    Ok(None)
}

fn result_rank(result: &NatResult) -> u8 {
    match (result.kind, result.estimated, result.mapped_address.is_some()) {
        ("unknown", _, false) => 0,
        ("unknown", _, true) => 1,
        (_, true, _) => 2,
        _ => 3,
    }
}

pub async fn check(port: u16, timeout_ms: u64) -> Result<NatResult> {
    let deadline = Instant::now() + detection_timeout(timeout_ms);
    let mut probes = JoinSet::new();
    // Each server gets a separate source port: probing one must not open the other's filter.
    // At most three candidates run, all through the already-selected private node inlet.
    for server in SERVERS {
        probes.spawn(async move { (server, check_server(port, server).await) });
    }
    let mut best = NatResult::unknown("No usable STUN observations");
    let mut attempts = Vec::new();
    while !probes.is_empty() {
        match timeout_at(deadline, probes.join_next()).await {
            Ok(Some(Ok((server, Ok(mut result))))) => {
                attempts.push(format!("{server}: {}", result.detail.as_deref().unwrap_or(result.kind)));
                result.detail = Some(format!(
                    "STUN {server}:3478. {}",
                    result.detail.as_deref().unwrap_or_default(),
                ));
                if result_rank(&result) > result_rank(&best) {
                    best = result;
                }
                if result_rank(&best) == 3 {
                    break;
                }
            }
            Ok(Some(Ok((server, Err(error))))) => attempts.push(format!("{server}: {error:#}")),
            Ok(Some(Err(error))) => attempts.push(format!("STUN task failed: {error}")),
            Ok(None) => break,
            Err(_) => {
                attempts.push("Overall STUN deadline reached; retained completed observations".into());
                break;
            }
        }
    }
    // Close every association before the caller changes the private group's selected node.
    probes.abort_all();
    while probes.join_next().await.is_some() {}
    if !attempts.is_empty() {
        best.detail = Some(format!(
            "{}\nAttempts:\n{}",
            best.detail.as_deref().unwrap_or_default(),
            attempts.join("\n"),
        ));
    }
    Ok(best)
}

async fn check_server(port: u16, server: &str) -> Result<NatResult> {
    let mut control = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await?;
    control.write_all(&[5, 1, 0]).await?;
    let mut response = [0; 2];
    control.read_exact(&mut response).await?;
    ensure!(response == [5, 0], "SOCKS5 authentication rejected");
    let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let mut associate = vec![5, 3, 0];
    associate.extend_from_slice(&socks_address(socket.local_addr()?));
    control.write_all(&associate).await?;
    let mut header = [0; 4];
    control.read_exact(&mut header).await?;
    ensure!(header[..3] == [5, 0, 0], "SOCKS5 UDP associate rejected");
    let length = match header[3] {
        1 => 6,
        4 => 18,
        _ => bail!("SOCKS5 returned unsupported relay address"),
    };
    let mut relay = vec![0; length];
    control.read_exact(&mut relay).await?;
    // Mihomo binds UDP to the same private loopback listener. Never follow an external relay.
    let relay_port = u16::from_be_bytes([relay[length - 2], relay[length - 1]]);
    ensure!(relay_port == port, "unexpected SOCKS5 relay port");
    socket.connect((Ipv4Addr::LOCALHOST, port)).await?;
    let mut target = vec![3, server.len() as u8];
    target.extend_from_slice(server.as_bytes());
    target.extend_from_slice(&3478_u16.to_be_bytes());
    let (first, primary) = exchange_with_retries(&socket, &target, 0, None, &INITIAL_RETRY_DELAYS_MS)
        .await?
        .with_context(|| format!("No initial STUN response from {server}:3478 after 4 attempts / 7.5s; SOCKS5 UDP association succeeded. Check the core log for DNS or UDP forwarding errors; this does not prove UDP is blocked"))?;
    let mut result = NatResult {
        kind: "unknown",
        estimated: false,
        mapped_address: Some(first.mapped.to_string()),
        detail: None,
    };
    let Some(other) = first
        .other
        .filter(|a| a.ip() != primary.ip() && a.port() != primary.port() && !a.ip().is_loopback())
    else {
        result.detail = Some("STUN server did not advertise RFC 5780 alternate addresses".into());
        return Ok(result);
    };
    let primary_target = socks_address(primary);
    // Filtering must run before contacting the alternate endpoint, which would open a pinhole.
    let mut notes = Vec::new();
    let changed_source = exchange(&socket, &primary_target, 6, Some(other)).await;
    let full_timeout = matches!(&changed_source, Ok(None));
    let filtering = if observation(changed_source, "Change IP and port", &mut notes).is_some() {
        Some("full-cone")
    } else {
        let changed_port = exchange(
            &socket,
            &primary_target,
            2,
            Some(SocketAddr::new(primary.ip(), other.port())),
        )
        .await;
        let port_timeout = matches!(&changed_port, Ok(None));
        if observation(changed_port, "Change port", &mut notes).is_some() {
            Some("restricted-cone")
        } else if full_timeout && port_timeout {
            Some("port-restricted-cone")
        } else {
            None
        }
    };
    let mut alternate = observation(
        exchange(&socket, &socks_address(other), 0, Some(other)).await,
        "Alternate mapping check",
        &mut notes,
    );
    let used_alternate_port_fallback = alternate.is_none();
    if used_alternate_port_fallback {
        // Some paths block the alternate port. A different IP at the original port
        // still provides mapping evidence, after filtering observations are complete.
        let other_primary_port = SocketAddr::new(other.ip(), primary.port());
        alternate = observation(
            exchange(&socket, &socks_address(other_primary_port), 0, Some(other_primary_port)).await,
            "Alternate IP with primary port",
            &mut notes,
        );
    }
    let baseline = observation(
        exchange(&socket, &primary_target, 0, Some(primary)).await,
        "Baseline recheck",
        &mut notes,
    );
    result = classify(
        first.mapped,
        filtering,
        alternate.map(|b| b.mapped),
        baseline.map(|b| b.mapped),
    );
    if used_alternate_port_fallback && result.kind != "unknown" {
        result.estimated = true;
        notes.push("Estimated type: the original alternate IP/port could not be verified".into());
    }
    if !notes.is_empty() {
        result.detail = Some(format!(
            "{}. {}",
            result.detail.as_deref().unwrap_or_default(),
            notes.join(". "),
        ));
    }
    drop(control);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_evidence_retains_all_four_nat_types() {
        let first: SocketAddr = "203.0.113.11:5000".parse().unwrap();
        let changed: SocketAddr = "203.0.113.11:6000".parse().unwrap();
        let cases = [
            (Some("full-cone"), None, None, "full-cone", true),
            (Some("restricted-cone"), None, None, "restricted-cone", true),
            (Some("port-restricted-cone"), None, Some(first), "port-restricted-cone", true),
            (Some("port-restricted-cone"), Some(first), None, "port-restricted-cone", true),
            (None, Some(changed), None, "symmetric", true),
            (Some("full-cone"), Some(changed), Some(first), "symmetric", false),
            (None, Some(changed), Some(changed), "symmetric", true),
            (Some("full-cone"), Some(first), Some(first), "full-cone", false),
            // An interrupted UDP path and malformed filtering probes are not port restriction.
            (Some("port-restricted-cone"), None, None, "unknown", false),
            (None, Some(first), Some(first), "unknown", false),
        ];
        for (filtering, alternate, baseline, kind, estimated) in cases {
            let result = classify(first, filtering, alternate, baseline);
            assert_eq!((result.kind, result.estimated), (kind, estimated));
            assert_eq!(result.mapped_address.as_deref(), Some("203.0.113.11:5000"));
            assert!(result.detail.is_some());
        }
    }

    #[test]
    fn failed_candidates_cannot_replace_mapping_or_type_evidence() {
        let first: SocketAddr = "203.0.113.11:5000".parse().unwrap();
        let failed = NatResult::unknown("candidate timed out");
        let mapped = classify(first, None, None, None);
        let estimated = classify(first, Some("restricted-cone"), None, None);
        let verified = classify(first, Some("full-cone"), Some(first), Some(first));
        assert!(result_rank(&failed) < result_rank(&mapped));
        assert!(result_rank(&mapped) < result_rank(&estimated));
        assert!(result_rank(&estimated) < result_rank(&verified));
    }

    #[test]
    fn accepts_legacy_changed_address_without_overriding_other_address() {
        let transaction = [7; 12];
        let mut bytes = vec![1, 1, 0, 36];
        bytes.extend_from_slice(&COOKIE);
        bytes.extend_from_slice(&transaction);
        bytes.extend_from_slice(&[0, 1, 0, 8, 0, 1, 0x13, 0x88, 203, 0, 113, 11]);
        bytes.extend_from_slice(&[0x80, 0x2c, 0, 8, 0, 1, 0x0d, 0x97, 203, 0, 113, 2]);
        bytes.extend_from_slice(&[0, 5, 0, 8, 0, 1, 0x0d, 0x97, 203, 0, 113, 3]);
        assert_eq!(parse(&bytes, &transaction).unwrap().other.unwrap().to_string(), "203.0.113.2:3479");
        bytes.drain(32..44);
        bytes[3] = 24;
        assert_eq!(parse(&bytes, &transaction).unwrap().other.unwrap().to_string(), "203.0.113.3:3479");
    }

    #[tokio::test]
    async fn initial_exchange_accepts_reply_after_udp_session_startup() {
        let relay = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let client = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        client.connect(relay.local_addr().unwrap()).await.unwrap();
        let target = socks_address("203.0.113.1:3478".parse().unwrap());
        let server = async {
            let mut request = [0; 128];
            let (_, peer) = relay.recv_from(&mut request).await.unwrap();
            // A valid response arrives after the old 2.4-second deadline.
            tokio::time::sleep(Duration::from_millis(2600)).await;
            let mut reply = vec![0, 0, 0];
            reply.extend_from_slice(&target);
            reply.extend_from_slice(&[1, 1, 0, 12]);
            reply.extend_from_slice(&COOKIE);
            reply.extend_from_slice(&request[18..30]);
            reply.extend_from_slice(&[0, 1, 0, 8, 0, 1, 0x13, 0x88, 203, 0, 113, 11]);
            relay.send_to(&reply, peer).await.unwrap();
        };
        let probe = exchange_with_retries(&client, &target, 0, None, &INITIAL_RETRY_DELAYS_MS);
        let (_, result) = tokio::join!(server, probe);
        let (binding, source) = result.unwrap().unwrap();
        assert_eq!(binding.mapped.to_string(), "203.0.113.11:5000");
        assert_eq!(source.to_string(), "203.0.113.1:3478");
    }

    #[tokio::test]
    async fn malformed_udp_reply_is_not_reported_as_no_response() {
        let relay = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let client = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        client.connect(relay.local_addr().unwrap()).await.unwrap();
        let target = socks_address("203.0.113.1:3478".parse().unwrap());
        let server = async {
            let mut request = [0; 128];
            let (_, peer) = relay.recv_from(&mut request).await.unwrap();
            relay.send_to(&[0, 0, 1, 1], peer).await.unwrap();
        };
        let probe = exchange_with_retries(&client, &target, 0, None, &[100]);
        let (_, result) = tokio::join!(server, probe);
        let error = result.err().unwrap();
        assert!(format!("{error:#}").contains("fragmented or invalid SOCKS5 UDP packet"));
    }

    #[test]
    fn detection_budget_covers_all_exchanges_even_with_short_latency_timeout() {
        let exchanges = Duration::from_millis(
            INITIAL_RETRY_DELAYS_MS.iter().sum::<u64>() + RETRY_DELAYS_MS.iter().sum::<u64>() * 5,
        );
        for latency_timeout in [0, 1000, 3000, 5000, 10000] {
            assert!(detection_timeout(latency_timeout) >= exchanges + Duration::from_secs(3));
        }
        assert_eq!(detection_timeout(25000), Duration::from_secs(25));
        assert_eq!(detection_timeout(u64::MAX), Duration::from_secs(30));
    }

    #[test]
    fn parses_xor_and_rejects_truncation_and_wrong_transaction() {
        let transaction = [7; 12];
        let mut bytes = vec![1, 1, 0, 12];
        bytes.extend_from_slice(&COOKIE);
        bytes.extend_from_slice(&transaction);
        bytes.extend_from_slice(&[0, 0x20, 0, 8, 0, 1, 0x32, 0x9a, 0xea, 0x12, 0xd5, 0x49]);
        let result = parse(&bytes, &transaction).unwrap();
        assert_eq!(result.mapped.to_string(), "203.0.113.11:5000");
        assert!(parse(&bytes[..bytes.len() - 1], &transaction).is_err());
        assert!(parse(&bytes, &[8; 12]).is_err());
    }

    #[test]
    fn socks_udp_rejects_fragments() {
        let mut bytes = vec![0, 0, 0];
        bytes.extend_from_slice(&socks_address("203.0.113.1:3478".parse().unwrap()));
        bytes.extend_from_slice(b"response");
        let (source, body) = unwrap_packet(&bytes).unwrap();
        assert_eq!(source.to_string(), "203.0.113.1:3478");
        assert_eq!(body, b"response");
        bytes[2] = 1;
        assert!(unwrap_packet(&bytes).is_err());
    }
}
