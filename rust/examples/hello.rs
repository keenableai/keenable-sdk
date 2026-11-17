//! One keyless search, printed as a citable block.
//!
//!     cargo run --example hello
//!
//! Set KEENABLE_API_KEY to raise the rate limit; the code stays the same.

#[tokio::main]
async fn main() -> Result<(), keenable::Error> {
    let client = keenable::Client::new()?;
    let results = client
        .search("how wafer scale chips avoid the memory bottleneck")
        .await?;
    println!("{}", results.to_context());
    Ok(())
}
