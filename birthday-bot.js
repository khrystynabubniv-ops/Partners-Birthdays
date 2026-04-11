const { Client } = require("@notionhq/client");
const { WebClient } = require("@slack/web-api");
const cron = require("node-cron");

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = "281135c9b8ac4a40ac16c8c6ac34955f";
const SLACK_TOKEN = process.env.SLACK_TOKEN;
const SLACK_CHANNEL = "C0AR67VRHU5";

const notion = new Client({ auth: NOTION_TOKEN });
const slack = new WebClient(SLACK_TOKEN);

function toMonthDay(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}

function getTargetMonthDay(daysAhead) {
  const now = new Date();
  now.setDate(now.getDate() + daysAhead);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const months = [
    "січня","лютого","березня","квітня","травня","червня",
    "липня","серпня","вересня","жовтня","листопада","грудня"
  ];
  const d = new Date(dateStr);
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

function daysLabel(n) {
  if (n === 1) return "день";
  if (n >= 2 && n <= 4) return "дні";
  return "днів";
}

function buildMessage(record, daysAhead) {
  const name = record.name;
  const parts = [record.company, record.position].filter(Boolean).join(", ");
  const subtitle = parts ? ` (${parts})` : "";
  const dateFormatted = formatDate(record.birthday);

  if (daysAhead === 0) {
    return `🎉 Сьогодні день народження у *${name}*${subtitle}\n📅 ${dateFormatted}`;
  }
  return `🎂 За ${daysAhead} ${daysLabel(daysAhead)} — день народження у *${name}*${subtitle}\n📅 ${dateFormatted}`;
}

async function fetchBirthdays() {
  const results = [];
  let cursor = undefined;

  do {
    const response = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const page of response.results) {
      const props = page.properties;
      const birthdayDate = props["Дата ДН"]?.date?.start ?? null;
      if (!birthdayDate) continue;

      results.push({
        name: props["Імʼя"]?.title?.[0]?.plain_text ?? "—",
        company: props["Компанія"]?.rich_text?.[0]?.plain_text ?? "",
        position: props["Посада"]?.rich_text?.[0]?.plain_text ?? "",
        birthday: birthdayDate,
        monthDay: toMonthDay(birthdayDate),
      });
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return results;
}

async function checkAndNotify() {
  console.log(`[${new Date().toISOString()}] Перевіряємо дні народження...`);

  const records = await fetchBirthdays();
  const targetDays = [0, 3, 5, 10];
  let sent = 0;

  for (const daysAhead of targetDays) {
    const target = getTargetMonthDay(daysAhead);
    const matches = records.filter((r) => r.monthDay === target);

    for (const record of matches) {
      const text = buildMessage(record, daysAhead);
      try {
        await slack.chat.postMessage({ channel: SLACK_CHANNEL, text });
        console.log(`✓ Надіслано: ${record.name} (за ${daysAhead} днів)`);
        sent++;
      } catch (err) {
        console.error(`✗ Помилка для ${record.name}:`, err.message);
      }
    }
  }

  console.log(`Готово. Надіслано ${sent} повідомлень.`);
}

if (process.argv.includes("--run-once")) {
  checkAndNotify().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  cron.schedule("0 8 * * *", () => {
    checkAndNotify().catch(console.error);
  }, { timezone: "UTC" });

  console.log("Birthday bot запущено. Очікуємо 11:00 Київ (08:00 UTC)...");
}
