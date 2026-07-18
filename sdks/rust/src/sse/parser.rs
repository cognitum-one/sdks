//! Protocol-agnostic Server-Sent Events (SSE) byte-level parser (ADR-0024a
//! §D5, ADR-0023 §D8 for the caller-facing time budgets that wrap this
//! parser -- this module itself has no timing logic).
//!
//! Pure state machine with NO Meta-LLM (or any other product) knowledge --
//! this module is reused as-is for Anthropic Messages streaming and
//! Responses streaming when those land in follow-up work (issue #58 tracks
//! only `chat.completions` streaming this pass). Consumes raw bytes via
//! [`SseParser::feed`] (arbitrary fragmentation: chunks may split mid-line,
//! mid-field, or mid-UTF-8 codepoint -- bytes are buffered and only decoded
//! once a complete line's bytes are known, so a split multi-byte codepoint
//! at a chunk boundary is always safe) and yields fully-parsed [`SseEvent`]
//! values. Multiple `data:` lines are joined with `\n` per the SSE spec;
//! comment lines (leading `:`) are dropped; CRLF, lone CR, and LF line
//! endings are all accepted.
//!
//! Bounded-garbage handling (ADR-0024a §D5 "bounded unknown events"): a
//! single physical line over `max_line_bytes`, one event's joined `data:`
//! payload over `max_event_bytes`, or unterminated buffered bytes over
//! `max_buffered_bytes` are all dropped as malformed rather than growing
//! memory without bound; `max_malformed_events` caps how many such drops
//! are tolerated before [`SseParser::feed`] returns [`SseParseError`] and
//! the caller must abort the stream.
//!
//! Deliberate simplification vs. the full WHATWG EventSource processing
//! model: the `id`/`retry` fields reset with every dispatched event rather
//! than persisting as a `last-event-id` across events (SSE reconnection
//! semantics) -- none of the three target protocols (OpenAI, Anthropic,
//! Responses) rely on client-driven SSE reconnection this pass.

/// Sane defaults (ADR-0024a §D5 defers exact numbers to "the contract
/// bundle", which does not exist yet -- these are a documented starting
/// point, not a frozen contract value): generous enough for real chat
/// completions (a single `data:` line rarely exceeds a few KiB; a full
/// accumulated event practically never approaches 256 KiB), while still
/// bounding a hostile or buggy server's memory impact.
pub const DEFAULT_MAX_LINE_BYTES: usize = 64 * 1024;
pub const DEFAULT_MAX_EVENT_BYTES: usize = 256 * 1024;
pub const DEFAULT_MAX_BUFFERED_BYTES: usize = 1024 * 1024;
pub const DEFAULT_MAX_MALFORMED_EVENTS: usize = 50;

const LF: u8 = 0x0a;
const CR: u8 = 0x0d;

/// One fully-parsed, dispatched SSE event (generic -- no protocol knowledge).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SseEvent {
    /// The `event:` field, if any. `None` means the default "message" type per spec.
    pub event: Option<String>,
    /// All `data:` lines for this event, joined with `\n` (SSE spec).
    pub data: String,
    /// The `id:` field, if any and not containing a NUL byte.
    pub id: Option<String>,
    /// The `retry:` field in milliseconds, if any and all-ASCII-digit.
    pub retry: Option<u64>,
}

/// Options controlling [`SseParser`]'s bounded-garbage limits.
#[derive(Debug, Clone, Copy)]
pub struct SseParserOptions {
    /// Max bytes for a single physical line before it is dropped as malformed.
    pub max_line_bytes: usize,
    /// Max cumulative bytes for one event's joined `data:` payload.
    pub max_event_bytes: usize,
    /// Max unterminated buffered bytes before treating the stream as broken.
    pub max_buffered_bytes: usize,
    /// Max malformed/oversized lines or events tolerated before aborting.
    pub max_malformed_events: usize,
}

impl Default for SseParserOptions {
    fn default() -> Self {
        Self {
            max_line_bytes: DEFAULT_MAX_LINE_BYTES,
            max_event_bytes: DEFAULT_MAX_EVENT_BYTES,
            max_buffered_bytes: DEFAULT_MAX_BUFFERED_BYTES,
            max_malformed_events: DEFAULT_MAX_MALFORMED_EVENTS,
        }
    }
}

/// Fatal parser condition -- the stream must be aborted (too much unparseable garbage).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SseParseError {
    #[error("SSE parser buffered {buffered} bytes without a line terminator (limit {limit})")]
    BufferOverflow { buffered: usize, limit: usize },
    #[error("SSE parser exceeded {limit} malformed/oversized lines or events")]
    TooManyMalformedEvents { limit: usize },
}

/// Result of [`SseParser::finish`].
#[derive(Debug, Clone, Default)]
pub struct SseParserFinishResult {
    /// Any final event resolvable only at true end-of-stream (see [`SseParser::finish`]).
    pub events: Vec<SseEvent>,
    /// `true` if bytes for an event were buffered but never dispatched (no trailing blank line).
    pub had_undispatched_data: bool,
    /// Total malformed/oversized lines or events dropped over the parser's lifetime.
    pub malformed_event_count: usize,
}

/// Push-based SSE state machine: feed bytes in, get parsed events out. Not itself async.
#[derive(Debug)]
pub struct SseParser {
    options: SseParserOptions,

    buffer: Vec<u8>,

    event_type: Option<String>,
    data_lines: Vec<String>,
    data_bytes_len: usize,
    event_id: Option<String>,
    retry_ms: Option<u64>,
    poisoned: bool,

    malformed_count: usize,
}

impl Default for SseParser {
    fn default() -> Self {
        Self::new()
    }
}

impl SseParser {
    pub fn new() -> Self {
        Self::with_options(SseParserOptions::default())
    }

    pub fn with_options(options: SseParserOptions) -> Self {
        Self {
            options,
            buffer: Vec::new(),
            event_type: None,
            data_lines: Vec::new(),
            data_bytes_len: 0,
            event_id: None,
            retry_ms: None,
            poisoned: false,
            malformed_count: 0,
        }
    }

    /// Feed the next chunk of raw bytes (any size, any split point --
    /// including mid-UTF-8-codepoint). Returns zero or more
    /// fully-dispatched events, in order.
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<SseEvent>, SseParseError> {
        self.append_to_buffer(chunk)?;
        let mut events = Vec::new();
        while let Some(line) = self.take_line(false) {
            if let Some(event) = self.process_line(line)? {
                events.push(event);
            }
        }
        Ok(events)
    }

    /// Signal end of stream (no more bytes will ever arrive). Resolves the
    /// one ambiguity [`feed`](Self::feed) cannot: a trailing lone CR with
    /// nothing after it is held back by `feed` because a following LF
    /// (making it CRLF) might still arrive -- at true EOF that ambiguity is
    /// resolved (no more bytes are coming, so a trailing CR IS a
    /// terminator), and this may therefore flush one final event. Any OTHER
    /// undispatched partial event/line (i.e. real data with no terminator
    /// at all) is dropped, matching the SSE spec: dispatch only happens on
    /// a blank line, and a stream that closes mid-event never sends one.
    /// This does NOT error -- whether an incomplete stream is an error is
    /// protocol-specific (e.g. "did we see `[DONE]`?"), which is the
    /// caller's decision, not this generic parser's.
    pub fn finish(&mut self) -> Result<SseParserFinishResult, SseParseError> {
        let mut events = Vec::new();
        while let Some(line) = self.take_line(true) {
            if let Some(event) = self.process_line(line)? {
                events.push(event);
            }
        }
        Ok(SseParserFinishResult {
            events,
            had_undispatched_data: !self.data_lines.is_empty() || !self.buffer.is_empty(),
            malformed_event_count: self.malformed_count,
        })
    }

    fn append_to_buffer(&mut self, chunk: &[u8]) -> Result<(), SseParseError> {
        self.buffer.extend_from_slice(chunk);
        if self.buffer.len() > self.options.max_buffered_bytes {
            return Err(SseParseError::BufferOverflow {
                buffered: self.buffer.len(),
                limit: self.options.max_buffered_bytes,
            });
        }
        Ok(())
    }

    /// Removes and returns the next complete line's raw bytes (terminator
    /// excluded), or `None` if no complete line is available yet. Accepts
    /// LF, CRLF, and lone CR (SSE/HTML spec line-terminator rule).
    ///
    /// A trailing CR with no following byte yet is ambiguous -- it might be
    /// the first half of a CRLF pair whose LF just hasn't arrived, or it
    /// might be a lone-CR terminator. [`feed`](Self::feed) calls this with
    /// `at_eof=false` and withholds judgement until a following byte (or
    /// true end of stream) disambiguates it, so a CRLF pair split exactly
    /// at the CR/LF boundary across two `feed` calls is handled correctly.
    /// [`finish`](Self::finish) calls this with `at_eof=true`, resolving
    /// that same trailing CR as a valid terminator since no more bytes will
    /// ever arrive.
    fn take_line(&mut self, at_eof: bool) -> Option<Vec<u8>> {
        for i in 0..self.buffer.len() {
            let byte = self.buffer[i];
            if byte == LF {
                let line = self.buffer[..i].to_vec();
                self.buffer.drain(..=i);
                return Some(line);
            }
            if byte == CR {
                if i + 1 < self.buffer.len() {
                    let consumed = if self.buffer[i + 1] == LF {
                        i + 2
                    } else {
                        i + 1
                    };
                    let line = self.buffer[..i].to_vec();
                    self.buffer.drain(..consumed);
                    return Some(line);
                }
                if at_eof {
                    let line = self.buffer[..i].to_vec();
                    self.buffer.drain(..=i);
                    return Some(line);
                }
                return None; // need more bytes to know if this is CRLF or a lone CR
            }
        }
        None
    }

    fn note_malformed(&mut self) -> Result<(), SseParseError> {
        self.malformed_count += 1;
        if self.malformed_count > self.options.max_malformed_events {
            return Err(SseParseError::TooManyMalformedEvents {
                limit: self.options.max_malformed_events,
            });
        }
        Ok(())
    }

    fn process_line(&mut self, line_bytes: Vec<u8>) -> Result<Option<SseEvent>, SseParseError> {
        if line_bytes.len() > self.options.max_line_bytes {
            self.note_malformed()?;
            return Ok(None);
        }
        let line = String::from_utf8_lossy(&line_bytes).into_owned();

        if line.is_empty() {
            return Ok(self.dispatch());
        }
        if line.starts_with(':') {
            return Ok(None); // comment line -- always ignored, even in the malformed budget
        }

        let (field, mut value) = match line.find(':') {
            Some(idx) => (line[..idx].to_owned(), line[idx + 1..].to_owned()),
            None => (line, String::new()),
        };
        if value.starts_with(' ') {
            value = value[1..].to_owned();
        }

        match field.as_str() {
            "event" => self.event_type = Some(value),
            "data" => {
                let additional = value.len() + usize::from(!self.data_lines.is_empty());
                if !self.poisoned && self.data_bytes_len + additional > self.options.max_event_bytes
                {
                    self.poisoned = true;
                    self.note_malformed()?;
                }
                if !self.poisoned {
                    self.data_lines.push(value);
                    self.data_bytes_len += additional;
                }
            }
            "id" => {
                if !value.contains('\u{0}') {
                    self.event_id = Some(value);
                }
            }
            "retry" if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => {
                self.retry_ms = value.parse::<u64>().ok();
            }
            _ => {} // unrecognized field name (including a non-numeric "retry") -- ignored per the SSE spec, not an error
        }
        Ok(None)
    }

    fn dispatch(&mut self) -> Option<SseEvent> {
        let had_data = !self.data_lines.is_empty();
        let event = if had_data && !self.poisoned {
            Some(SseEvent {
                event: self.event_type.clone(),
                data: self.data_lines.join("\n"),
                id: self.event_id.clone(),
                retry: self.retry_ms,
            })
        } else {
            None
        };
        self.event_type = None;
        self.data_lines.clear();
        self.data_bytes_len = 0;
        self.event_id = None;
        self.retry_ms = None;
        self.poisoned = false;
        event
    }
}
