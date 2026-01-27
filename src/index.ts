import Parser from "rss-parser";
import { readFileSync, writeFileSync, existsSync } from "fs";

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

type Category = keyof FeedsConfig;

// Config
const POSTED_FILE = process.env.DATA_PATH || "./posted.json";
const FEEDS_FILE = "./feeds.json";
const HOURS_24 = 24 * 60 * 60 * 1000;

const WEBHOOK_MAP: Record<Category, string | undefined> = {
  technology: process.env.SLACK_WEBHOOK_TECHNOLOGY,
  corporate_finance: process.env.SLACK_WEBHOOK_CORPORATE_FINANCE,
  eam_build_up: process.env.SLACK_WEBHOOK_EAM_BUILD_UP,
};

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
  const content = item.contentSnippet || item.content || item.summary || "";
  // Strip HTML and truncate
  const text = content.replace(/<[^>]*>/g, "").trim();
  return truncate(text, 200);
}

// Post to Slack
async function postToSlack(
  webhookUrl: string,
  article: { title: string; link: string; source: string; summary: string }
): Promise<boolean> {
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*<${article.link}|${article.title}>*\n_${article.source}_`,
            },
          },
          {
            type: "section",
            text: {
              type: "plain_text",
              text: article.summary || "No summary available.",
              emoji: true,
            },
          },
          { type: "divider" },
        ],
      }),
    });
    return response.ok;
  } catch (error) {
    console.error(`Failed to post to Slack: ${error}`);
    return false;
  }
}

// Delay helper
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fetch and process a single feed
async function processFeed(
  parser: Parser,
  feed: Feed,
  category: Category,
  posted: PostedArticles,
  cutoffTime: number
): Promise<{ title: string; link: string; source: string; summary: string }[]> {
  const articles: { title: string; link: string; source: string; summary: string }[] = [];

  try {
    console.log(`Fetching: ${feed.name}`);
    const result = await parser.parseURL(feed.url);

    for (const item of result.items) {
      const link = item.link;
      if (!link) continue;

      // Skip if already posted
      if (posted[link]) continue;

      // Check if article is from last 24 hours
      const pubDate = item.pubDate ? new Date(item.pubDate).getTime() : 0;
      if (pubDate < cutoffTime) continue;

      articles.push({
        title: item.title || "Untitled",
        link,
        source: feed.name,
        summary: getSummary(item),
      });
    }
  } catch (error) {
    console.error(`Error fetching ${feed.name}: ${error}`);
  }

  return articles;
}

// Main function
async function main() {
  console.log("Starting RSS aggregator...");

  // Load feeds config
  const feeds: FeedsConfig = JSON.parse(readFileSync(FEEDS_FILE, "utf-8"));

  // Load and clean posted articles
  let posted = loadPosted();
  posted = cleanOldEntries(posted);

  const parser = new Parser({
    timeout: 10000,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; RSSBot/1.0)",
    },
  });

  const cutoffTime = Date.now() - HOURS_24;
  const categories: Category[] = ["technology", "corporate_finance", "eam_build_up"];

  for (const category of categories) {
    const webhookUrl = WEBHOOK_MAP[category];
    if (!webhookUrl) {
      console.log(`No webhook configured for ${category}, skipping...`);
      continue;
    }

    console.log(`\nProcessing category: ${category}`);
    const feedList = feeds[category];

    for (const feed of feedList) {
      const articles = await processFeed(parser, feed, category, posted, cutoffTime);

      for (const article of articles) {
        const success = await postToSlack(webhookUrl, article);
        if (success) {
          posted[article.link] = Date.now();
          console.log(`Posted: ${article.title}`);
        }
        // Rate limit delay
        await delay(1000);
      }
    }
  }

  // Save posted articles
  savePosted(posted);
  console.log("\nDone!");
}

main().catch(console.error);
