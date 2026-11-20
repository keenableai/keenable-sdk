//! A raw HTTP/1.1 server on 127.0.0.1 for tests: it records every request and
//! answers each from a script.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// One reply: status, headers and body.
#[derive(Clone, Debug)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Reply {
    pub fn new(status: u16, body: &str) -> Reply {
        Reply {
            status,
            headers: Vec::new(),
            body: body.to_string(),
        }
    }

    pub fn header(mut self, name: &str, value: &str) -> Reply {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }
}

/// A request the server saw.
#[derive(Clone, Debug)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Seen {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// How the server answers.
#[derive(Clone)]
pub enum Script {
    /// The replies in order; the last one repeats.
    Replies(Vec<Reply>),
    /// A fetch reply for /v1/fetch, a search reply for anything else.
    ByPath { search: Reply, fetch: Reply },
}

pub struct Server {
    pub base_url: String,
    pub seen: Arc<Mutex<Vec<Seen>>>,
}

impl Server {
    pub fn requests(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    pub fn count(&self) -> usize {
        self.seen.lock().unwrap().len()
    }
}

pub async fn start(script: Script) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
    let record = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let record = record.clone();
            let script = script.clone();
            tokio::spawn(async move {
                let _ = serve(stream, record, script).await;
            });
        }
    });
    Server { base_url, seen }
}

/// Reads one request: its head and a Content-Length body. `None` at EOF.
pub async fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<Seen>> {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    while !buf.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).await? == 0 {
            return Ok(None);
        }
        buf.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&buf).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let method = first.next().unwrap_or("").to_string();
    let target = first.next().unwrap_or("").to_string();
    let mut headers = Vec::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    let length: usize = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    stream.read_exact(&mut body).await?;
    let path = target
        .split_once('?')
        .map_or(target.clone(), |(p, _)| p.to_string());
    Ok(Some(Seen {
        method,
        path,
        headers,
        body,
    }))
}

async fn serve(
    mut stream: TcpStream,
    record: Arc<Mutex<Vec<Seen>>>,
    script: Script,
) -> std::io::Result<()> {
    while let Some(req) = read_request(&mut stream).await? {
        let reply = {
            let mut seen = record.lock().unwrap();
            let n = seen.len();
            let reply = match &script {
                Script::Replies(list) => list[n.min(list.len() - 1)].clone(),
                Script::ByPath { search, fetch } => {
                    if req.path.contains("/v1/fetch") {
                        fetch.clone()
                    } else {
                        search.clone()
                    }
                }
            };
            seen.push(req);
            reply
        };
        let mut out = format!("HTTP/1.1 {} Reply\r\n", reply.status);
        for (k, v) in &reply.headers {
            out.push_str(&format!("{k}: {v}\r\n"));
        }
        out.push_str(&format!(
            "Content-Length: {}\r\n\r\n{}",
            reply.body.len(),
            reply.body
        ));
        stream.write_all(out.as_bytes()).await?;
    }
    Ok(())
}

const DEADLINE_JSON: &str = r#"{"results": []}"#;

/// A server that answers every request as a deadline case says
/// (scripts/conformance/cases/deadline.json).
pub async fn deadline_server(phase: &str, interval: Duration, pieces: usize) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let phase = phase.to_string();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let phase = phase.clone();
            tokio::spawn(async move {
                if read_request(&mut stream).await.ok().flatten().is_none() {
                    return;
                }
                if serve_phase(&mut stream, &phase, interval, pieces)
                    .await
                    .is_ok()
                {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            });
        }
    });
    base
}

async fn serve_phase(
    stream: &mut TcpStream,
    phase: &str,
    interval: Duration,
    pieces: usize,
) -> std::io::Result<()> {
    let rest = format!(
        "Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{DEADLINE_JSON}",
        DEADLINE_JSON.len()
    );
    match phase {
        "headers" => {
            stream.write_all(b"HTTP/1.1 200 OK\r\nX-Slow: ").await?;
            for _ in 0..pieces {
                tokio::time::sleep(interval).await;
                stream.write_all(b"a").await?;
            }
            stream.write_all(format!("\r\n{rest}").as_bytes()).await
        }
        "body" => {
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                        pieces + DEADLINE_JSON.len()
                    )
                    .as_bytes(),
                )
                .await?;
            for _ in 0..pieces {
                tokio::time::sleep(interval).await;
                stream.write_all(b" ").await?;
            }
            stream.write_all(DEADLINE_JSON.as_bytes()).await
        }
        "terminator" => {
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n",
                )
                .await?;
            tokio::time::sleep(interval).await;
            stream
                .write_all(format!("{:x}\r\n{DEADLINE_JSON}\r\n", DEADLINE_JSON.len()).as_bytes())
                .await?;
            for _ in 0..pieces {
                tokio::time::sleep(interval).await;
                stream.write_all(b"0\r\n\r\n").await?;
            }
            Ok(())
        }
        _ => {
            stream
                .write_all(format!("HTTP/1.1 200 OK\r\n{rest}").as_bytes())
                .await
        }
    }
}
