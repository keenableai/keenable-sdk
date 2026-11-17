//! A strict JSON reader for API bodies and tool-call arguments.
//!
//! It reads JSON the way the other SDKs do (scripts/conformance/README.md):
//! `NaN`, `Infinity` and trailing data are not JSON, a leading byte order mark
//! is ignored, a body nested deeper than 512 levels is not JSON, and a number
//! too large for a double drops that field only (an array keeps its length
//! with a null in its place). `serde_json` fails the whole body on such a
//! number, so this module parses the text itself and builds a
//! [`serde_json::Value`].

use serde_json::{Map, Number, Value};

/// The nesting past which a body is "not JSON" in every SDK.
const MAX_DEPTH: usize = 512;

/// Parses `raw` as one JSON value. `None` means the text is not JSON.
pub(crate) fn parse(raw: &[u8]) -> Option<Value> {
    let raw = raw.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(raw);
    let text = String::from_utf8_lossy(raw);
    let mut parser = Parser {
        bytes: text.as_bytes(),
        pos: 0,
        depth: 0,
    };
    parser.skip_ws();
    let value = parser.value()?;
    parser.skip_ws();
    if parser.pos != parser.bytes.len() {
        return None;
    }
    // A bare overflowing number is still JSON; it carries nothing.
    Some(value.unwrap_or(Value::Null))
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
    depth: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    fn literal(&mut self, word: &[u8]) -> Option<()> {
        if self.bytes[self.pos..].starts_with(word) {
            self.pos += word.len();
            Some(())
        } else {
            None
        }
    }

    /// One value. `Some(None)` is a number that does not fit a double.
    fn value(&mut self) -> Option<Option<Value>> {
        match self.peek()? {
            b'{' => self.object().map(Some),
            b'[' => self.array().map(Some),
            b'"' => self.string().map(|s| Some(Value::String(s))),
            b't' => self.literal(b"true").map(|()| Some(Value::Bool(true))),
            b'f' => self.literal(b"false").map(|()| Some(Value::Bool(false))),
            b'n' => self.literal(b"null").map(|()| Some(Value::Null)),
            b'-' | b'0'..=b'9' => self.number(),
            _ => None,
        }
    }

    fn enter(&mut self) -> Option<()> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            None
        } else {
            Some(())
        }
    }

    fn object(&mut self) -> Option<Value> {
        self.enter()?;
        self.pos += 1;
        let mut map = Map::new();
        self.skip_ws();
        if self.peek()? == b'}' {
            self.pos += 1;
            self.depth -= 1;
            return Some(Value::Object(map));
        }
        loop {
            self.skip_ws();
            if self.peek()? != b'"' {
                return None;
            }
            let key = self.string()?;
            self.skip_ws();
            if self.peek()? != b':' {
                return None;
            }
            self.pos += 1;
            self.skip_ws();
            match self.value()? {
                Some(v) => {
                    map.insert(key, v);
                }
                // An overflowing number drops its field, and so does an
                // earlier value under the same key: the last one wins.
                None => {
                    map.remove(&key);
                }
            }
            self.skip_ws();
            match self.peek()? {
                b',' => self.pos += 1,
                b'}' => {
                    self.pos += 1;
                    self.depth -= 1;
                    return Some(Value::Object(map));
                }
                _ => return None,
            }
        }
    }

    fn array(&mut self) -> Option<Value> {
        self.enter()?;
        self.pos += 1;
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek()? == b']' {
            self.pos += 1;
            self.depth -= 1;
            return Some(Value::Array(items));
        }
        loop {
            self.skip_ws();
            items.push(self.value()?.unwrap_or(Value::Null));
            self.skip_ws();
            match self.peek()? {
                b',' => self.pos += 1,
                b']' => {
                    self.pos += 1;
                    self.depth -= 1;
                    return Some(Value::Array(items));
                }
                _ => return None,
            }
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.pos;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.pos += 1;
        }
        self.pos - start
    }

    fn number(&mut self) -> Option<Option<Value>> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek()? {
            b'0' => self.pos += 1,
            b'1'..=b'9' => {
                self.digits();
            }
            _ => return None,
        }
        let mut integer = true;
        if self.peek() == Some(b'.') {
            self.pos += 1;
            integer = false;
            if self.digits() == 0 {
                return None;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            integer = false;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if self.digits() == 0 {
                return None;
            }
        }
        let text = std::str::from_utf8(&self.bytes[start..self.pos]).ok()?;
        if integer {
            if let Ok(n) = text.parse::<i64>() {
                return Some(Some(Value::Number(n.into())));
            }
            if let Ok(n) = text.parse::<u64>() {
                return Some(Some(Value::Number(n.into())));
            }
        }
        let f: f64 = text.parse().ok()?;
        Some(Number::from_f64(f).map(Value::Number))
    }

    fn hex4(&mut self) -> Option<u32> {
        let chunk = self.bytes.get(self.pos..self.pos + 4)?;
        let text = std::str::from_utf8(chunk).ok()?;
        if !text.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        self.pos += 4;
        u32::from_str_radix(text, 16).ok()
    }

    fn string(&mut self) -> Option<String> {
        self.pos += 1; // the opening quote
        let mut out = String::new();
        loop {
            let start = self.pos;
            while let Some(b) = self.peek() {
                if b == b'"' || b == b'\\' || b < 0x20 {
                    break;
                }
                self.pos += 1;
            }
            out.push_str(std::str::from_utf8(&self.bytes[start..self.pos]).ok()?);
            match self.peek()? {
                b'"' => {
                    self.pos += 1;
                    return Some(out);
                }
                b'\\' => {
                    self.pos += 1;
                    let esc = self.peek()?;
                    self.pos += 1;
                    match esc {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => out.push(self.unicode_escape()?),
                        _ => return None,
                    }
                }
                _ => return None, // a raw control character
            }
        }
    }

    /// The character after `\u`. A lone surrogate becomes U+FFFD, which is
    /// the closest a Rust string can hold.
    fn unicode_escape(&mut self) -> Option<char> {
        let first = self.hex4()?;
        if (0xD800..0xDC00).contains(&first) {
            if self.bytes[self.pos..].starts_with(b"\\u") {
                let save = self.pos;
                self.pos += 2;
                let second = self.hex4()?;
                if (0xDC00..0xE000).contains(&second) {
                    let c = 0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00);
                    return char::from_u32(c);
                }
                self.pos = save;
            }
            return Some('\u{FFFD}');
        }
        Some(char::from_u32(first).unwrap_or('\u{FFFD}'))
    }
}

#[cfg(test)]
mod tests {
    use super::parse;
    use serde_json::json;

    #[test]
    fn reads_plain_json() {
        assert_eq!(
            parse(br#"{"a":[1,2.5,"x",true,null],"b":{}}"#),
            Some(json!({"a":[1,2.5,"x",true,null],"b":{}}))
        );
    }

    #[test]
    fn refuses_what_json_is_not() {
        for text in [
            "NaN",
            "[Infinity]",
            "{} x",
            "{\"a\":01}",
            "[1,]",
            "'a'",
            "",
            "{\"a\" 1}",
            "\"\u{1}\"",
        ] {
            assert_eq!(parse(text.as_bytes()), None, "{text}");
        }
    }

    #[test]
    fn drops_an_overflowing_number_only() {
        assert_eq!(parse(br#"{"a":1e400,"b":2}"#), Some(json!({"b":2})));
        assert_eq!(parse(b"[1e400, 1]"), Some(json!([null, 1])));
        assert_eq!(parse(b"1e400"), Some(json!(null)));
    }

    #[test]
    fn skips_a_byte_order_mark() {
        assert_eq!(parse(b"\xEF\xBB\xBF{}"), Some(json!({})));
    }

    #[test]
    fn limits_the_depth() {
        let ok = format!("{}{}", "[".repeat(512), "]".repeat(512));
        assert!(parse(ok.as_bytes()).is_some());
        let deep = format!("{}{}", "[".repeat(513), "]".repeat(513));
        assert_eq!(parse(deep.as_bytes()), None);
    }

    #[test]
    fn decodes_escapes() {
        assert_eq!(
            parse(concat!("\"", "\\u00e9", "\\ud83d\\ude00", "\\ud800\\n\"").as_bytes()),
            Some(json!("é😀\u{FFFD}\n"))
        );
    }
}
