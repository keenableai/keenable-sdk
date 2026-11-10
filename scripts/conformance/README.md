# SDK conformance cases

The Python, TypeScript and Go SDKs must behave the same. The cases in
`cases/*.json` pin that behaviour down as input and expected outcome, and
`sync.ts` copies them, in one explicit form, to each SDK's tests:

- `go/testdata/conformance.json`, run by `go/conformance_test.go`
- `python/tests/fixtures/conformance.json`, run by `python/tests/test_conformance.py`
  (on both `Keenable` and `AsyncKeenable`)
- `typescript/test/fixtures/conformance.json`, run by `typescript/test/conformance.test.ts`

To change a behaviour, edit a case file, run `node scripts/conformance/sync.ts`
(Node 22.18+), and make all three SDKs pass. CI runs
`node scripts/conformance/sync.ts --check`, which fails when a copy is out of
date. A case an SDK cannot express (a `NaN` for Go's `time.Duration`) names that
SDK in `skip`, with the reason.

The rules the cases encode:

## fetch() targets (`fetch_url`)

A refused URL raises the invalid-request error and sends nothing. In order:

1. The URL is a string with no control character (U+0000 to U+001F, U+007F) and
   no leading or trailing space.
2. The scheme is `http` or `https` (any case), followed by exactly `://`. This
   refuses `https:host`, `https:/host` and `https:///host`, which WHATWG parsers
   read as `https://host/`.
3. The authority (up to the first `/`, `?` or `#`) has no backslash: WHATWG
   parsers read `\` as `/`, other parsers do not, so the two disagree on the host.
4. The host is read as the language's URL parser reads it, then percent-decoded,
   width-folded (`１２７。０。０。１` is `127.0.0.1`), stripped of the characters
   IDNA mapping deletes (soft hyphen U+00AD, U+200B, U+2060, U+FEFF),
   lowercased, and stripped of IPv6 brackets, an IPv6 zone and trailing dots.
   An empty host is refused.
5. `localhost`, any name under `.localhost`, and `metadata.google.internal` are
   refused.
6. An IP literal, including IPv4 written as one number, in hex or octal, or with
   fewer than four parts (`2130706433`, `0x7f.1`, `0177.0.0.1`, `127.1`), is
   refused when it is in one of these ranges:
   - IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`,
     `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`,
     `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`,
     `224.0.0.0/4`, `240.0.0.0/4`.
   - IPv6: an IPv4-mapped address (`::ffff:0:0/96`) is judged by its IPv4
     address. Any other address is allowed only inside `2000::/3`, and not in
     `2001::/23`, `2001:db8::/32`, `2002::/16` or `3fff::/20`. This refuses
     `::1`, `::`, IPv4-compatible `::a.b.c.d`, NAT64 `64:ff9b::/96` and
     `64:ff9b:1::/48`, `100::/64`, `fc00::/7`, `fe80::/10`, `fec0::/10` and
     `ff00::/8`.

   The list is explicit in each SDK rather than taken from the standard
   library, whose idea of "private" differs by language and version.
7. Any other hostname is allowed; the API's own guard is the backstop.

## Base URLs (`base_url`)

Surrounding whitespace and trailing slashes are dropped. The URL must be
`https`, or `http` to `localhost`, `127.0.0.1` or `::1` (a trailing dot on the
host is ignored), with a host and no query or fragment.

## Retry-After (`retry_after`)

The header (trimmed) is delay-seconds (`^[0-9]+$`) or an RFC 9110 HTTP-date in
one of three forms, with day and month names in any case:

- IMF-fixdate: `Sun, 06 Nov 1994 08:49:37 GMT`
- RFC 850: `Sunday, 06-Nov-94 08:49:37 GMT` (`69` to `99` are 19xx, `00` to `68`
  are 20xx)
- asctime: `Sun Nov  6 08:49:37 1994` (the day is ` 6`, `6`, `06` or `16`)

The zone must be `GMT` where the form has one. Two-digit days, hours, minutes
and seconds, a real calendar day, an hour under 24 and a second under 60 are
required; the weekday is not checked against the date. Anything else is no
value, so the next source is used (the body's `retry_after_seconds` comes
first, then this header, then the older `retryAfter`). A date gives the seconds
until it, rounded up and at least 0. Both kinds are capped at a year.

## Retries (`retry`)

The API's boolean `retryable` decides when present. Otherwise 408, 429 and 5xx
are retried. A retried error waits its Retry-After when it has one, unless that
is over 60 seconds (then the error is raised at once), else exponential backoff.
Connection errors and timeouts are retried. A 3xx is never followed, whatever
the host, and becomes a connection error that is not retried: the request is
sent once, to the configured host, and the key goes nowhere else. This holds
with a caller's own `httpx` client, `http.Client` or `fetch` too.

## Errors (`errors`)

- The class follows the status: 401/403 are authentication errors unless the
  type is `target_error`, 402 is the insufficient-credits error, 429 the
  rate-limit error, anything else the API error.
- The detail (`body`) is the first of the body's `message`, `error` and `detail`
  that is a string with more than whitespace. Other types are skipped, never
  stringified. A body that is JSON but not an object gives no detail and no
  fields. A body that is not JSON gives its trimmed text.
- JSON is strict: `NaN` and `Infinity` are not JSON, nor is trailing data. A
  leading byte order mark is ignored. A number too large for a double drops that
  field only.
- `value` and `reason` are read only from a 400 whose `error` is
  `invalid_filter`; `param` names the parameter they belong to, from the
  body's `param`, else its `field`.
- String fields count only when they are strings with more than whitespace;
  `retryable` only when boolean; delays only when finite numbers at least 0
  (capped at a year); `limit.max` only when an integer from 0 to 2^53 - 1.
- The SDKs do not expose `docs_url`, the billing, checkout and top-up URLs of a
  402 (`billing_url`, `auto_top_up_url`, `details.checkoutUrl`), the
  `pay_per_request` text, or an x402 offer (`accepts`, `payTo`, networks,
  assets). They are in no field and no message, and errors carry no raw body.
  A 402's message is the SDK's own sentence, not the API's text: "Keenable:
  payment required (402)" for an x402 or `payment_*` response, which this SDK
  cannot pay, else "Keenable: insufficient credits (402)".

## Success bodies (`responses`)

A body that is not a JSON object is an API error and is not retried. Required
text fields (`title`, `url`, `snippet`, `content`) are the string sent or `""`;
optional ones are a string with more than whitespace or null. A date
(`published_at`, `acquired_at`) is such a string, kept as sent, or a number of
Unix seconds, which fetch sends: it becomes ISO 8601 UTC to the second,
`2024-05-01T12:00:00Z`, with any fraction dropped. A number below 1, past
`253402300799` (the end of the year 9999, so a millisecond value too) or not
finite is null, as is a boolean or any other type. A page's `truncated` is a
boolean and its `total_chars` an integer from 0 to 2^53 - 1, else null. A search echoes
the query the API sent back when it is such a string, else the query asked; a
page's `url` likewise falls back to the URL asked for. The request id is the
body's, else the trimmed `X-Request-Id` header.

## Arguments (`options`, `search_body`, `fetch_params`)

- `max_retries` is an integer of 0 or more; unset means the default (client) or
  the client's (call).
- A per-call timeout is a finite number above 0; unset keeps the client's. A
  timeout over 2,147,483.647 seconds (about 24.8 days, the longest a JavaScript
  timer can wait) is treated as that long.
- Header names are HTTP tokens and values hold no CR, LF or NUL; anything else is
  the invalid-request error, not a retried connection failure. `X-API-Key` is
  ignored: the key always comes from the client.
- The query is a string with more than whitespace, sent as given. An empty
  string filter is unset, and an unset mode is `pro`. A mode is sent as given
  (`pro` or `realtime`); the SDKs do not check it. A list filter
  (`exclude_domains`) takes any iterable and is sent as a list of the entries
  as given, an empty one as `[]`; a lone string is one entry, and `""` is
  sent as `[""]` so the API rejects it rather than searching unfiltered. A value the
  language cannot encode as JSON (`NaN`, bytes, an arbitrary object) is the
  invalid-request error and sends nothing.
- fetch() sends its options as query parameters next to `url`, and only the
  ones that are set: `max_chars` as the number's digits, `live` as `true` and
  only when it is true (the API reads `true` and `false` and nothing else, and
  an absent `live` is false), and `prompt` as given. An empty prompt is unset.
  The URL is checked first (`fetch_url`), so a refused URL sends nothing
  whatever the options.

## Tool calls (`tool_call`)

A `keenable_search` call's arguments, as JSON text, give the body sent or the
invalid-request error. A list filter (`exclude_domains`) is sent as the model
gave it for the API to judge: a lone string is wrapped, not split; `""` and
null are unset; anything else, an empty list or a blank entry included, is
sent unchanged. Arguments JSON cannot encode (`NaN`, `Infinity`) are the
invalid-request error and send nothing.
