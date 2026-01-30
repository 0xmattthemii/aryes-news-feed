import Parser from "rss-parser";
import { readFileSync, writeFileSync, existsSync } from "fs";

// Logging
type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

function log(level: LogLevel, message: string, data?: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level}]`;
  const dataStr = data ? ` ${JSON.stringify(data)}` : "";
  const line = `${prefix} ${message}${dataStr}`;

  if (level === "ERROR") {
    console.error(line);
  } else if (level === "WARN") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// Types
interface Feed {
  name: string;
  url: string;
}

interface FeedsConfig {
  technology: Feed[];
  corporate_finance: Feed[];
  eam_build_up: Feed[];
}

interface PostedArticles {
  [url: string]: number; // timestamp when posted
}

interface Article {
  title: string;
  link: string;
  source: string;
  summary: string;
  imageUrl?: string;
}

type Category = keyof FeedsConfig;

// Config
const POSTED_FILE = process.env.DATA_PATH || "./posted.json";
const FEEDS_FILE = "./feeds.json";
const HOURS_24 = 24 * 60 * 60 * 1000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const WEBHOOK_MAP: Record<Category, string | undefined> = {
  technology: process.env.SLACK_WEBHOOK_TECHNOLOGY,
  corporate_finance: process.env.SLACK_WEBHOOK_CORPORATE_FINANCE,
  eam_build_up: process.env.SLACK_WEBHOOK_EAM_BUILD_UP,
};

const CATEGORY_PROMPTS: Record<Category, string> = {
  technology: `Aryes Advisory provides technology consulting to financial services and corporate clients.

RELEVANT (answer "yes"):
- AI and machine learning developments, especially enterprise applications
- Blockchain and digital assets: institutional adoption, infrastructure, regulation
- Cybersecurity threats and solutions
- Digital transformation in banking and finance
- Fintech innovation

NOT RELEVANT (answer "no"):
- Consumer gadgets and product reviews
- Gaming news
- Social media drama or celebrity tech news
- Crypto price movements and market speculation`,

  corporate_finance: `Aryes Advisory advises on M&A, fundraising, and valuations across Europe and Switzerland.

RELEVANT (answer "yes"):
- Mergers and acquisitions: deal announcements, trends, analysis
- Private equity and venture capital activity
- Funding rounds and exits
- Corporate strategy and valuation trends
- European and Swiss deal flow
- Financial regulation impacting transactions

NOT RELEVANT (answer "no"):
- Stock market daily movements
- Personal finance tips
- Retail banking products
- Earnings reports without strategic significance`,

  eam_build_up: `Aryes is building a capital arm to acquire and consolidate Swiss external asset managers (EAMs).

RELEVANT (answer "yes"):
- Swiss wealth management industry news
- EAM and independent asset manager consolidation
- Private banking M&A
- FINMA regulatory changes affecting asset managers
- Family office trends
- European wealth management consolidation
- Key players: UBS, Julius Baer, Pictet, Lombard Odier, Vontobel, EFG, etc.
- AuM movements and senior hires in Swiss private banking

NOT RELEVANT (answer "no"):
- Retail banking news
- General investment advice
- Fund performance rankings
- US-only wealth management news`,
};

// Custom parser to extract media content
type CustomFeed = Record<string, unknown>;
type CustomItem = {
  "media:content"?: { $?: { url?: string } };
  "media:thumbnail"?: { $?: { url?: string } };
  enclosure?: { url?: string };
  content?: string;
};

const parser = new Parser<CustomFeed, CustomItem>({
  timeout: 10000,
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; RSSBot/1.0)",
  },
  customFields: {
    item: [
      ["media:content", "media:content"],
      ["media:thumbnail", "media:thumbnail"],
      ["enclosure", "enclosure"],
    ],
  },
});

// Load posted articles
function loadPosted(): PostedArticles {
  if (!existsSync(POSTED_FILE)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(POSTED_FILE, "utf-8"));
  } catch {
    return {};
  }
}

// Save posted articles
function savePosted(posted: PostedArticles): void {
  writeFileSync(POSTED_FILE, JSON.stringify(posted, null, 2));
}

// Clean old entries (older than 7 days to keep file small)
function cleanOldEntries(posted: PostedArticles): PostedArticles {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const cleaned: PostedArticles = {};
  for (const [url, timestamp] of Object.entries(posted)) {
    if (timestamp > cutoff) {
      cleaned[url] = timestamp;
    }
  }
  return cleaned;
}

// Truncate text to max length
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

// Extract summary from item
function getSummary(item: Parser.Item): string {
  const content =
    item.contentSnippet || item.content || (item as { summary?: string }).summary || "";
  // Strip HTML and truncate
  const text = content.replace(/<[^>]*>/g, "").trim();
  return truncate(text, 200);
}

// Extract image URL from item
function getImageUrl(item: Parser.Item & CustomItem): string | undefined {
  // Try media:content
  if (item["media:content"]?.$?.url) {
    return item["media:content"].$.url;
  }

  // Try media:thumbnail
  if (item["media:thumbnail"]?.$?.url) {
    return item["media:thumbnail"].$.url;
  }

  // Try enclosure (often used for images)
  if (item.enclosure?.url) {
    const url = item.enclosure.url;
    if (url.match(/\.(jpg|jpeg|png|gif|webp)/i)) {
      return url;
    }
  }

  // Try to extract from content HTML
  const content = item.content || "";
  const imgMatch = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch?.[1]) {
    return imgMatch[1];
  }

  return undefined;
}

// Check relevance using Claude
async function isRelevant(
  article: Article,
  category: Category
): Promise<boolean> {
  if (!ANTHROPIC_API_KEY) {
    log("WARN", "No ANTHROPIC_API_KEY set, skipping relevance check — all articles will be posted");
    return true;
  }

  log("DEBUG", `Checking relevance with AI`, {
    article: article.title,
    category,
  });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        messages: [
          {
            role: "user",
            content: `Is this article relevant for Aryes Advisory's "${category.replace(/_/g, " ")}" news feed?

${CATEGORY_PROMPTS[category]}

ARTICLE TO EVALUATE:
Title: ${article.title}
Summary: ${article.summary}

Answer only "yes" or "no".`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      log("ERROR", `Anthropic API error — defaulting to relevant`, {
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
        article: article.title,
      });
      return true; // Default to relevant if API fails
    }

    const data = (await response.json()) as {
      content: { type: string; text: string }[];
    };
    const answer = data.content[0]?.text?.toLowerCase().trim();
    const relevant = answer === "yes";

    log("INFO", `AI relevance result: ${relevant ? "RELEVANT" : "NOT RELEVANT"}`, {
      article: article.title,
      category,
      aiAnswer: answer,
    });

    return relevant;
  } catch (error) {
    log("ERROR", `Relevance check exception — defaulting to relevant`, {
      error: String(error),
      article: article.title,
      category,
    });
    return true; // Default to relevant if check fails
  }
}

// Post to Slack
async function postToSlack(
  webhookUrl: string,
  article: Article
): Promise<boolean> {
  log("INFO", `Posting to Slack: "${article.title}"`, {
    source: article.source,
    link: article.link,
    hasImage: !!article.imageUrl,
  });

  try {
    const sectionBlock: Record<string, unknown> = {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*<${article.link}|${article.title}>*\n_${article.source}_\n\n${article.summary || "No summary available."}`,
      },
    };

    // Add image as accessory (displays on the right side)
    if (article.imageUrl) {
      sectionBlock.accessory = {
        type: "image",
        image_url: article.imageUrl,
        alt_text: article.title,
      };
    }

    const blocks: unknown[] = [sectionBlock, { type: "divider" }];
    const payload = { blocks, unfurl_links: false, unfurl_media: false };

    log("DEBUG", "Slack request payload", {
      webhookUrlPrefix: webhookUrl.slice(0, 60) + "...",
      payloadSize: JSON.stringify(payload).length,
    });

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const responseBody = await response.text();

    if (!response.ok) {
      log("ERROR", `Slack API returned error`, {
        status: response.status,
        statusText: response.statusText,
        body: responseBody,
        article: article.title,
        webhookUrlPrefix: webhookUrl.slice(0, 60) + "...",
      });
      return false;
    }

    log("INFO", `Slack post succeeded`, {
      status: response.status,
      body: responseBody,
      article: article.title,
    });
    return true;
  } catch (error) {
    log("ERROR", `Failed to post to Slack (network/exception)`, {
      error: String(error),
      article: article.title,
      link: article.link,
    });
    return false;
  }
}

// Delay helper
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fetch and process a single feed
async function processFeed(
  feed: Feed,
  posted: PostedArticles,
  cutoffTime: number
): Promise<Article[]> {
  const articles: Article[] = [];

  try {
    log("INFO", `Fetching feed: ${feed.name}`, { url: feed.url });
    const result = await parser.parseURL(feed.url);

    let totalItems = 0;
    let skippedAlreadyPosted = 0;
    let skippedTooOld = 0;
    let skippedNoLink = 0;

    for (const item of result.items) {
      totalItems++;
      const link = item.link;
      if (!link) {
        skippedNoLink++;
        continue;
      }

      // Skip if already posted
      if (posted[link]) {
        skippedAlreadyPosted++;
        continue;
      }

      // Check if article is from last 24 hours
      const pubDate = item.pubDate ? new Date(item.pubDate).getTime() : 0;
      if (pubDate < cutoffTime) {
        skippedTooOld++;
        continue;
      }

      articles.push({
        title: item.title || "Untitled",
        link,
        source: feed.name,
        summary: getSummary(item),
        imageUrl: getImageUrl(item as Parser.Item & CustomItem),
      });
    }

    log("INFO", `Feed fetched: ${feed.name}`, {
      totalItems,
      newArticles: articles.length,
      skippedAlreadyPosted,
      skippedTooOld,
      skippedNoLink,
    });
  } catch (error) {
    log("ERROR", `Failed to fetch feed: ${feed.name}`, {
      url: feed.url,
      error: String(error),
    });
  }

  return articles;
}

// Main function
async function main() {
  log("INFO", "=== Starting RSS aggregator run ===");

  // Log configuration state
  for (const [category, url] of Object.entries(WEBHOOK_MAP)) {
    if (url) {
      log("INFO", `Webhook configured for ${category}`, {
        webhookUrlPrefix: url.slice(0, 60) + "...",
      });
    } else {
      log("WARN", `No webhook configured for ${category} — this category will be skipped`);
    }
  }

  if (ANTHROPIC_API_KEY) {
    log("INFO", "Anthropic API key is set — AI relevance filtering enabled");
  } else {
    log("WARN", "Anthropic API key is NOT set — all articles will be posted without filtering");
  }

  // Load feeds config
  const feeds: FeedsConfig = JSON.parse(readFileSync(FEEDS_FILE, "utf-8"));
  log("INFO", "Feeds config loaded", {
    technology: feeds.technology.length,
    corporate_finance: feeds.corporate_finance.length,
    eam_build_up: feeds.eam_build_up.length,
  });

  // Load and clean posted articles
  let posted = loadPosted();
  const beforeClean = Object.keys(posted).length;
  posted = cleanOldEntries(posted);
  const afterClean = Object.keys(posted).length;
  log("INFO", "Posted articles loaded", {
    total: afterClean,
    cleaned: beforeClean - afterClean,
  });

  const cutoffTime = Date.now() - HOURS_24;
  const categories: Category[] = ["technology", "corporate_finance", "eam_build_up"];

  // Run counters
  let totalArticlesFound = 0;
  let totalRelevant = 0;
  let totalNotRelevant = 0;
  let totalPosted = 0;
  let totalSlackFailures = 0;

  for (const category of categories) {
    const webhookUrl = WEBHOOK_MAP[category];
    if (!webhookUrl) {
      log("WARN", `Skipping category: ${category} (no webhook URL)`);
      continue;
    }

    log("INFO", `--- Processing category: ${category} ---`);
    const feedList = feeds[category];

    for (const feed of feedList) {
      const articles = await processFeed(feed, posted, cutoffTime);
      totalArticlesFound += articles.length;

      for (const article of articles) {
        // Check relevance with AI
        const relevant = await isRelevant(article, category);
        if (!relevant) {
          log("INFO", `Skipped (not relevant): "${article.title}"`, {
            source: article.source,
            category,
          });
          totalNotRelevant++;
          // Still mark as "posted" to avoid re-checking
          posted[article.link] = Date.now();
          continue;
        }

        totalRelevant++;

        const success = await postToSlack(webhookUrl, article);
        if (success) {
          posted[article.link] = Date.now();
          totalPosted++;
        } else {
          totalSlackFailures++;
          log("WARN", `Failed to post article — will retry next run`, {
            article: article.title,
            link: article.link,
          });
        }
        // Rate limit delay
        await delay(1000);
      }
    }
  }

  // Save posted articles
  savePosted(posted);

  log("INFO", "=== Run complete ===", {
    totalArticlesFound,
    totalRelevant,
    totalNotRelevant,
    totalPosted,
    totalSlackFailures,
  });
}

// Run immediately, then every 30 minutes
async function run() {
  try {
    await main();
  } catch (error) {
    log("ERROR", "Unhandled error in main()", { error: String(error) });
  }
}

const THIRTY_MINUTES = 30 * 60 * 1000;

log("INFO", "Scheduler started — running immediately, then every 30 minutes");
run();
setInterval(run, THIRTY_MINUTES);
