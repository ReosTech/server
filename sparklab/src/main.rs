use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, Connection};
use scraper::{Html as ScraperHtml, Selector};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tower_http::{catch_panic::CatchPanicLayer, timeout::TimeoutLayer};
use tracing::{error, info, warn};

// ============================================================================
// 1. DATA STRUCTURES & DATABASE ARCHITECTURE
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub score: f64,
}

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
}

#[derive(Deserialize)]
pub struct CrawlRequest {
    pub url: String,
    pub max_pages: Option<usize>,
}

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub client: reqwest::Client,
}

#[derive(Debug)]
pub enum EngineError {
    Database(String),
}

impl IntoResponse for EngineError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            EngineError::Database(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
        };
        (status, Html(format!("<h1>Search Engine Error</h1><p>{}</p>", msg))).into_response()
    }
}

// ============================================================================
// 2. INVERTED INDEX & BM25 RANKING ENGINE
// ============================================================================

pub struct InvertedIndex {
    index: HashMap<String, Vec<(usize, usize)>>,
    doc_lengths: Vec<usize>,
    avg_doc_length: f64,
    total_docs: usize,
}

impl InvertedIndex {
    pub fn build(docs: &[SearchResult]) -> Self {
        let mut index: HashMap<String, Vec<(usize, usize)>> = HashMap::new();
        let mut doc_lengths = Vec::with_capacity(docs.len());
        let mut total_len = 0;

        for (doc_id, doc) in docs.iter().enumerate() {
            let tokens = Self::tokenize(&format!("{} {}", doc.title, doc.snippet));
            doc_lengths.push(tokens.len());
            total_len += tokens.len();

            let mut term_freqs: HashMap<String, usize> = HashMap::new();
            for token in tokens {
                *term_freqs.entry(token).or_insert(0) += 1;
            }

            for (term, freq) in term_freqs {
                index.entry(term).or_default().push((doc_id, freq));
            }
        }

        let avg_doc_length = if docs.is_empty() {
            0.0
        } else {
            total_len as f64 / docs.len() as f64
        };

        InvertedIndex {
            index,
            doc_lengths,
            avg_doc_length,
            total_docs: docs.len(),
        }
    }

    fn tokenize(text: &str) -> Vec<String> {
        text.to_lowercase()
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { ' ' })
            .collect::<String>()
            .split_whitespace()
            .filter(|w| w.len() > 1)
            .map(|w| w.to_string())
            .collect()
    }

    pub fn rank(&self, query: &str, docs: &[SearchResult]) -> Vec<SearchResult> {
        let query_tokens = Self::tokenize(query);
        let mut scores = vec![0.0f64; docs.len()];

        let k1 = 1.2;
        let b = 0.75;

        for token in query_tokens {
            if let Some(postings) = self.index.get(&token) {
                let n = postings.len() as f64;
                let idf = ((self.total_docs as f64 - n + 0.5) / (n + 0.5) + 1.0).ln();

                for &(doc_id, tf) in postings {
                    let doc_len = self.doc_lengths[doc_id] as f64;
                    let tf_f64 = tf as f64;
                    let num = tf_f64 * (k1 + 1.0);
                    let den = tf_f64 + k1 * (1.0 - b + b * (doc_len / self.avg_doc_length));
                    scores[doc_id] += idf * (num / den);
                }
            }
        }

        let mut ranked: Vec<(f64, SearchResult)> = docs
            .iter()
            .cloned()
            .enumerate()
            .map(|(i, mut doc)| {
                doc.score = scores[i];
                (scores[i], doc)
            })
            .filter(|(score, _)| *score > 0.0)
            .collect();

        ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        ranked.into_iter().map(|(_, doc)| doc).collect()
    }
}

// ============================================================================
// 3. PURE-RUST NATIVE CRAWLER HANDLER
// ============================================================================

async fn trigger_crawl(
    State(state): State<AppState>,
    Json(payload): Json<CrawlRequest>,
) -> Result<Json<serde_json::Value>, EngineError> {
    let start_url = payload.url.clone();
    let limit = payload.max_pages.unwrap_or(10);

    tokio::spawn(async move {
        info!("🕷️ Starting crawl for: {}", start_url);

        let mut queue = vec![start_url.clone()];
        let mut visited = HashSet::new();
        let mut indexed_count = 0;

        let title_selector = Selector::parse("title").unwrap();
        let meta_desc_selector = Selector::parse("meta[name='description']").unwrap();

        while let Some(current_url) = queue.pop() {
            if visited.contains(&current_url) || indexed_count >= limit {
                continue;
            }
            visited.insert(current_url.clone());

            match state.client.get(&current_url).send().await {
                Ok(response) => {
                    if let Ok(html) = response.text().await {
                        let document = ScraperHtml::parse_document(&html);

                        let title = document
                            .select(&title_selector)
                            .next()
                            .map(|e| e.text().collect::<String>())
                            .unwrap_or_else(|| current_url.clone());

                        let snippet = document
                            .select(&meta_desc_selector)
                            .next()
                            .and_then(|e| e.value().attr("content"))
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| {
                                html.chars()
                                    .take(160)
                                    .collect::<String>()
                                    .replace('\n', " ")
                            });

                        if let Ok(db) = state.db.lock() {
                            let _ = db.execute(
                                "INSERT OR REPLACE INTO documents (url, title, snippet) VALUES (?1, ?2, ?3)",
                                params![current_url, title, snippet],
                            );
                            indexed_count += 1;
                        }
                    }
                }
                Err(err) => {
                    warn!("Failed to fetch URL {}: {}", current_url, err);
                }
            }
        }
        info!("✅ Crawl completed. Total indexed: {}", indexed_count);
    });

    Ok(Json(serde_json::json!({
        "status": "Crawl started",
        "target": payload.url
    })))
}

// ============================================================================
// 4. UNLIMITED BM25 SEARCH HANDLER
// ============================================================================

async fn handle_search(
    State(state): State<AppState>,
    Query(params): Query<SearchQuery>,
) -> Result<Html<String>, EngineError> {
    let query_text = params.q.unwrap_or_default().trim().to_string();

    let search_results_html = if query_text.is_empty() {
        "<p class='notice'>Enter a term to query your local SparkLab database.</p>".to_string()
    } else {
        let db = state.db.lock().map_err(|e| EngineError::Database(e.to_string()))?;

        let mut stmt = db
            .prepare("SELECT title, url, snippet FROM documents")
            .map_err(|e| EngineError::Database(e.to_string()))?;

        let raw_docs: Vec<SearchResult> = stmt
            .query_map([], |row| {
                Ok(SearchResult {
                    title: row.get(0)?,
                    url: row.get(1)?,
                    snippet: row.get(2)?,
                    score: 0.0,
                })
            })
            .map_err(|e| EngineError::Database(e.to_string()))?
            .filter_map(|r| r.ok())
            .collect();

        if raw_docs.is_empty() {
            "<p class='notice'>Index is empty. Trigger a crawl to seed pages into SQLite.</p>".to_string()
        } else {
            let index = InvertedIndex::build(&raw_docs);
            let ranked_results = index.rank(&query_text, &raw_docs);

            if ranked_results.is_empty() {
                "<p class='notice'>No matching documents found in local index.</p>".to_string()
            } else {
                ranked_results
                    .into_iter()
                    .map(|res| {
                        format!(
                            r#"<div class="card">
                                <a class="url" href="{}" target="_blank">{}</a>
                                <a class="title" href="{}" target="_blank">{}</a>
                                <p class="snippet">{}</p>
                                <span class="badge">BM25 Score: {:.4}</span>
                            </div>"#,
                            res.url, res.url, res.url, res.title, res.snippet, res.score
                        )
                    })
                    .collect::<Vec<String>>()
                    .join("")
            }
        }
    };

    let full_html = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>SparkLab Private Search Engine</title>
    <style>
        :root {{ --bg: #0f172a; --card: #1e293b; --text: #f8fafc; --accent: #38bdf8; --muted: #94a3b8; }}
        body {{ font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); padding: 2rem; display: flex; flex-direction: column; align-items: center; }}
        .container {{ width: 100%; max-width: 760px; }}
        h1 {{ font-size: 2rem; color: var(--accent); text-align: center; }}
        form {{ display: flex; gap: 0.5rem; margin-bottom: 2rem; }}
        input[type="text"] {{ flex: 1; padding: 0.85rem; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: #fff; }}
        button {{ padding: 0.85rem 1.5rem; border-radius: 8px; border: none; background: var(--accent); color: #0f172a; font-weight: 700; cursor: pointer; }}
        .card {{ background: var(--card); padding: 1.25rem; border-radius: 10px; margin-bottom: 1rem; border: 1px solid #334155; }}
        .url {{ font-size: 0.8rem; color: var(--muted); word-break: break-all; }}
        .title {{ font-size: 1.2rem; color: var(--accent); text-decoration: none; display: block; }}
        .snippet {{ font-size: 0.95rem; color: #cbd5e1; margin: 0.4rem 0; }}
        .badge {{ font-size: 0.7rem; background: #0284c7; color: #fff; padding: 0.2rem 0.4rem; border-radius: 4px; }}
        .notice {{ text-align: center; color: var(--muted); }}
    </style>
</head>
<body>
    <div class="container">
        <h1>⚡ SparkLab Private Search Engine</h1>
        <form action="/api/search" method="GET">
            <input type="text" name="q" placeholder="Search local BM25 database..." value="{}" required />
            <button type="submit">Search</button>
        </form>
        <div id="results">{}</div>
    </div>
</body>
</html>"#,
        query_text, search_results_html
    );

    Ok(Html(full_html))
}

// ============================================================================
// 5. APPLICATION INITIALIZATION
// ============================================================================

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = tracing_subscriber::fmt().try_init();

    let conn = Connection::open("search_engine.db")
        .map_err(|e| format!("Failed to open SQLite database: {}", e))?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS documents (
            url TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            snippet TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| format!("Failed to initialize schema: {}", e))?;

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) SparkLabCrawler/1.0")
        .timeout(Duration::from_secs(5))
        .build()?;

    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        client,
    };

    let app = Router::new()
        .route("/api/search", get(handle_search))
        .route("/crawl", post(trigger_crawl))
        .layer(TimeoutLayer::new(Duration::from_secs(10)))
        .layer(CatchPanicLayer::new())
        .with_state(state);

    let port = 5000;
    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => {
            info!("🚀 SparkLab Search Engine online on http://localhost:{}/api/search", port);
            axum::serve(listener, app).await?;
        }
        Err(e) => {
            error!("❌ Failed to bind to port {}: {}. Make sure port 5000 is free.", port, e);
            return Err(e.into());
        }
    }

    Ok(())
}
