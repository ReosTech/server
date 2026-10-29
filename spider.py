import asyncio
import aiohttp
import sqlite3
import re
from urllib.parse import urlparse, urljoin, parse_qs, urlunparse
from urllib.robotparser import RobotFileParser
from bs4 import BeautifulSoup
import time

# ============================================================================
# CRAWLER CONFIGURATION
# ============================================================================
API_URL = "http://localhost:5000/crawl"
DB_PATH = "search_engine.db"
USER_AGENT = "SparkLabBot/1.0 (+http://localhost:5000/bot-info)"

CONCURRENCY_LIMIT = 25       # Max parallel async workers
DOMAIN_DELAY = 1.0           # Seconds to wait between requests to the SAME domain
MAX_PAGES_PER_DOMAIN = 100   # Prevent crawling infinite pages on a single site
MAX_URL_LENGTH = 2000        # Ignore pathologically long URLs

INITIAL_SEEDS = [
    "https://reostech.pagekite.me/",
    "https://www.google.com/",
    "https://en.wikipedia.org/wiki/Main_Page",
    "https://news.ycombinator.com/",
    "https://github.com/explore",
    "https://www.w3.org/",
    "https://lobste.rs/",
    "https://dev.to/",
    "https://arxiv.org/"
]

# ============================================================================
# PRODUCTION CRAWLER ENGINE
# ============================================================================

class ProductionCrawler:
    def __init__(self):
        self.queue = asyncio.Queue()
        self.visited = set()
        self.domain_last_visited = {}
        self.domain_page_counts = {}
        self.robots_parsers = {}
        self.indexed_count = 0

    def normalize_url(self, url):
        """Clean, canonicalize, and strip query tracking params to prevent traps."""
        try:
            parsed = urlparse(url)
            
            # Lowercase scheme and host
            scheme = parsed.scheme.lower()
            netloc = parsed.netloc.lower()
            
            if scheme not in ("http", "https") or not netloc:
                return None

            # Remove standard tracking query params
            query_params = parse_qs(parsed.query)
            filtered_params = {
                k: v for k, v in query_params.items() 
                if not k.startswith(('utm_', 'ref', 'session', 'sid', 'fbclid', 'gclid'))
            }
            
            # Reconstruct sorted query string
            clean_query = "&".join(f"{k}={v[0]}" for k, v in sorted(filtered_params.items()))
            
            # Strip trailing slash from path for consistency
            path = parsed.path.rstrip('/') if parsed.path != '/' else '/'

            clean_url = urlunparse((scheme, netloc, path, parsed.params, clean_query, ''))
            return clean_url if len(clean_url) <= MAX_URL_LENGTH else None
        except Exception:
            return None

    def is_crawlable(self, url):
        """Filter non-HTML documents, dynamic traps, and media files."""
        if not url:
            return False

        parsed = urlparse(url)
        path = parsed.path.lower()

        # Reject static assets and binaries
        ignored_exts = (
            '.png', '.jpg', '.jpeg', '.gif', '.pdf', '.zip', '.tar', '.gz', 
            '.mp4', '.mp3', '.css', '.js', '.ico', '.svg', '.webp', '.xml',
            '.json', '.csv', '.dmg', '.exe', '.iso'
        )
        if path.endswith(ignored_exts):
            return False

        # Reject obvious calendar/pagination spider traps
        trap_patterns = [r'/calendar', r'/archive/\d{4}', r'/page/\d{4,}', r'/sort=', r'/filter=']
        for pattern in trap_patterns:
            if re.search(pattern, url, re.IGNORECASE):
                return False

        return True

    async def check_robots_txt(self, session, url):
        """Fetch and parse robots.txt rules for the target domain."""
        parsed = urlparse(url)
        domain = f"{parsed.scheme}://{parsed.netloc}"

        if domain in self.robots_parsers:
            return self.robots_parsers[domain].can_fetch(USER_AGENT, url)

        robots_url = f"{domain}/robots.txt"
        rp = RobotFileParser()
        rp.set_url(robots_url)

        try:
            async with session.get(robots_url, timeout=aiohttp.ClientTimeout(total=3)) as resp:
                if resp.status == 200:
                    body = await resp.text()
                    rp.parse(body.splitlines())
                else:
                    rp.allow_all = True
        except Exception:
            rp.allow_all = True

        self.robots_parsers[domain] = rp
        return rp.can_fetch(USER_AGENT, url)

    async def enforce_politeness(self, domain):
        """Ensure per-domain delays so target servers are not overwhelmed."""
        now = time.time()
        last_visited = self.domain_last_visited.get(domain, 0)
        elapsed = now - last_visited

        if elapsed < DOMAIN_DELAY:
            await asyncio.sleep(DOMAIN_DELAY - elapsed)

        self.domain_last_visited[domain] = time.time()

    async def send_to_rust_engine(self, session, url):
        """Dispatch clean URL payload to the local Rust Axum indexer."""
        try:
            async with session.post(
                API_URL, 
                json={"url": url, "max_pages": 1}, 
                timeout=aiohttp.ClientTimeout(total=5)
            ) as resp:
                if resp.status == 200:
                    self.indexed_count += 1
                    print(f"[{self.indexed_count}] ⚡ Indexed in Rust DB: {url}")
        except Exception:
            pass

    async def fetch_and_extract(self, session, url):
        """Fetch target HTML safely and extract outgoing links."""
        discovered = set()
        headers = {"User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9"}

        try:
            async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=8)) as resp:
                # Process HTML responses only
                content_type = resp.headers.get("Content-Type", "").lower()
                if resp.status == 200 and "text/html" in content_type:
                    html_text = await resp.text(errors="ignore")
                    soup = BeautifulSoup(html_text, "html.parser")

                    for a_tag in soup.find_all("a", href=True):
                        raw_href = a_tag["href"]
                        full_url = urljoin(url, raw_href)
                        clean_url = self.normalize_url(full_url)

                        if clean_url and self.is_crawlable(clean_url):
                            discovered.add(clean_url)
        except Exception:
            pass

        return discovered

    async def worker(self, worker_id, session):
        """Core asynchronous crawling task worker."""
        while True:
            url = await self.queue.get()
            try:
                parsed = urlparse(url)
                domain = parsed.netloc

                # Check per-domain budget caps
                current_domain_count = self.domain_page_counts.get(domain, 0)
                if current_domain_count >= MAX_PAGES_PER_DOMAIN:
                    continue

                # Check robots.txt rules
                allowed = await self.check_robots_txt(session, url)
                if not allowed:
                    continue

                # Rate-limit domain traffic
                await self.enforce_politeness(domain)

                # Increment domain count
                self.domain_page_counts[domain] = current_domain_count + 1

                # Send to indexer and discover new URLs
                await self.send_to_rust_engine(session, url)
                new_links = await self.fetch_and_extract(session, url)

                for link in new_links:
                    if link not in self.visited:
                        self.visited.add(link)
                        await self.queue.put(link)

            except Exception:
                pass
            finally:
                self.queue.task_done()

    async def start(self):
        print(f"⚙️ Starting Production Crawler with {CONCURRENCY_LIMIT} concurrent workers...")
        
        # Initialize queue with seed URLs
        for seed in INITIAL_SEEDS:
            clean_seed = self.normalize_url(seed)
            if clean_seed:
                self.visited.add(clean_seed)
                await self.queue.put(clean_seed)

        connector = aiohttp.TCPConnector(limit=100, ttl_dns_cache=300, ssl=False)
        async with aiohttp.ClientSession(connector=connector) as session:
            workers = [
                asyncio.create_task(self.worker(i, session))
                for i in range(CONCURRENCY_LIMIT)
            ]

            await self.queue.join()
            for worker in workers:
                worker.cancel()

# ============================================================================
# ENTRYPOINT
# ============================================================================
if __name__ == "__main__":
    crawler = ProductionCrawler()
    try:
        asyncio.run(crawler.start())
    except KeyboardInterrupt:
        print("\n🛑 Crawler stopped safely by user.")
