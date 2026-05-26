const { Client } = require("@notionhq/client");
const { WebClient } = require("@slack/web-api");
const cron = require("node-cron");

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = "281135c9b8ac4a40ac16c8c6ac34955f";
const SLACK_TOKEN = process.env.SLACK_TOKEN;
const SLACK_CHANNEL = "C0AR67VRHU5";
const SLACK_MESSAGE_SPACING_MS = Number(process.env.SLACK_MESSAGE_SPACING_MS || 6 * 60 * 1000);
const NOTION_REQUEST_SPACING_MS = Number(process.env.NOTION_REQUEST_SPACING_MS || 400);
const NOTION_RETRY_MAX_ATTEMPTS = Number(process.env.NOTION_RETRY_MAX_ATTEMPTS || 6);
const NOTION_RETRY_BASE_MS = Number(process.env.NOTION_RETRY_BASE_MS || 1000);
const CEO_SLACK_USER_ID = process.env.CEO_SLACK_USER_ID || process.env.CEO_SLACK_MENTION || "U0ADWP5UFTM";
const CEO_SLACK_DM_CHANNEL = process.env.CEO_SLACK_DM_CHANNEL || "D0AU2AFCSN6";
const CEO_SLACK_DISPLAY_NAME = process.env.CEO_SLACK_DISPLAY_NAME || "Iryna Blakyta";
const NOTION_DB_URL = "https://www.notion.so/281135c9b8ac4a40ac16c8c6ac34955f";
const DESIGN_TASK_BOT_URL = "https://genesistech.slack.com/archives/D0ATEC745GU";

const TRACKING_PROPERTIES = {
  messageTs: "Slack Message TS",
  messageChannel: "Slack Message Channel",
  reminderKey: "Slack Reminder Key",
  reminderDays: "Slack Reminder Days",
  statusSnapshot: "Slack Status Snapshot",
};

const notion = new Client({ auth: NOTION_TOKEN });
const slack = new WebClient(SLACK_TOKEN);
let trackingPropertiesEnsured = false;
let cachedCeoMention = null;
let lastNotionRequestAt = 0;

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

function getTargetIsoDate(daysAhead) {
  const now = new Date();
  now.setDate(now.getDate() + daysAhead);
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysToIsoDate(isoDate, daysAhead) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + daysAhead);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
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

function dayWord(daysAhead) {
  if (daysAhead === 1) return "день";
  if (daysAhead >= 2 && daysAhead <= 4) return "дні";
  return "днів";
}

function timingText(daysAhead) {
  return daysAhead === 0 ? "Сьогодні" : `За ${daysAhead} ${dayWord(daysAhead)}`;
}

function reminderKey(daysAhead) {
  return reminderKeyForDate(getTargetIsoDate(daysAhead), daysAhead);
}

function reminderKeyForDate(targetDate, daysAhead) {
  return `${targetDate}:${daysAhead}`;
}

function getArgValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHeaderValue(headers, name) {
  if (!headers) return "";

  if (typeof headers.get === "function") {
    return headers.get(name) || headers.get(name.toLowerCase()) || "";
  }

  const value = headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
  if (Array.isArray(value)) return value[0] ? String(value[0]) : "";
  return value ? String(value) : "";
}

function parseNotionErrorBody(err) {
  if (!err?.body) return {};
  if (typeof err.body === "object") return err.body;

  try {
    return JSON.parse(err.body);
  } catch {
    return {};
  }
}

function isRetryableNotionError(err) {
  const body = parseNotionErrorBody(err);
  const status = Number(err.status || err.statusCode || body.status);
  const code = err.code || body.code;

  return code === "rate_limited" || status === 429 || (status >= 500 && status < 600);
}

function getRetryAfterMs(err) {
  const retryAfter = getHeaderValue(err?.headers, "retry-after");
  if (!retryAfter) return null;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const retryDateMs = Date.parse(retryAfter);
  if (Number.isFinite(retryDateMs)) return Math.max(0, retryDateMs - Date.now());

  return null;
}

function getNotionRetryDelayMs(err, attemptIndex) {
  const retryAfterMs = getRetryAfterMs(err);
  if (Number.isFinite(retryAfterMs)) return retryAfterMs + 250;

  const retryBaseMs = Number.isFinite(NOTION_RETRY_BASE_MS) && NOTION_RETRY_BASE_MS > 0
    ? NOTION_RETRY_BASE_MS
    : 1000;
  const jitterMs = Math.floor(Math.random() * 250);

  return Math.min(retryBaseMs * (2 ** attemptIndex) + jitterMs, 30000);
}

async function waitForNotionSlot() {
  const spacingMs = Number.isFinite(NOTION_REQUEST_SPACING_MS) && NOTION_REQUEST_SPACING_MS > 0
    ? NOTION_REQUEST_SPACING_MS
    : 0;
  const elapsedMs = Date.now() - lastNotionRequestAt;

  if (elapsedMs < spacingMs) {
    await sleep(spacingMs - elapsedMs);
  }

  lastNotionRequestAt = Date.now();
}

async function withNotionRetry(label, operation) {
  const maxAttempts = Number.isFinite(NOTION_RETRY_MAX_ATTEMPTS) && NOTION_RETRY_MAX_ATTEMPTS > 0
    ? Math.floor(NOTION_RETRY_MAX_ATTEMPTS)
    : 6;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await waitForNotionSlot();
      return await operation();
    } catch (err) {
      if (!isRetryableNotionError(err) || attempt === maxAttempts) {
        throw err;
      }

      const delayMs = getNotionRetryDelayMs(err, attempt - 1);
      const seconds = Math.round(delayMs / 100) / 10;
      console.warn(`Notion тимчасово обмежив запит "${label}". Повтор ${attempt + 1}/${maxAttempts} через ${seconds} с.`);
      await sleep(delayMs);
    }
  }

  throw new Error(`Notion-запит "${label}" не виконався.`);
}

async function waitBeforeNextSlackPost(alreadyPosted) {
  if (!alreadyPosted || !Number.isFinite(SLACK_MESSAGE_SPACING_MS) || SLACK_MESSAGE_SPACING_MS <= 0) {
    return;
  }

  const seconds = Math.round(SLACK_MESSAGE_SPACING_MS / 1000);
  console.log(`Пауза ${seconds} секунд перед наступним Slack-повідомленням, щоб Slack показав бот-іконку окремо.`);
  await sleep(SLACK_MESSAGE_SPACING_MS);
}

function plainTextBlock(text) {
  return { type: "plain_text", text, emoji: true };
}

function mrkdwnBlock(text) {
  return { type: "mrkdwn", text };
}

function richTextProperty(value) {
  const text = value ? String(value).slice(0, 2000) : "";
  return text ? { rich_text: [{ text: { content: text } }] } : { rich_text: [] };
}

function getPropertyText(property) {
  if (!property) return "";

  if (property.type === "title") {
    return property.title?.map((part) => part.plain_text).join("").trim() ?? "";
  }

  if (property.type === "rich_text") {
    return property.rich_text?.map((part) => part.plain_text).join("").trim() ?? "";
  }

  if (property.type === "select") {
    return property.select?.name?.trim() ?? "";
  }

  if (property.type === "multi_select") {
    return property.multi_select?.map((item) => item.name).filter(Boolean).join(", ").trim() ?? "";
  }

  if (property.type === "status") {
    return property.status?.name?.trim() ?? "";
  }

  if (property.type === "formula") {
    const formula = property.formula;
    if (!formula) return "";
    if (formula.type === "string") return formula.string?.trim() ?? "";
    if (formula.type === "number") return formula.number === null || formula.number === undefined ? "" : String(formula.number);
    if (formula.type === "boolean") return formula.boolean ? "true" : "false";
    if (formula.type === "date") return formula.date?.start ?? "";
  }

  if (property.type === "number") {
    return property.number === null || property.number === undefined ? "" : String(property.number);
  }

  if (property.type === "checkbox") {
    return property.checkbox ? "true" : "false";
  }

  if (property.type === "url") {
    return property.url?.trim() ?? "";
  }

  if (property.type === "email") {
    return property.email?.trim() ?? "";
  }

  if (property.type === "phone_number") {
    return property.phone_number?.trim() ?? "";
  }

  if (property.type === "date") {
    return property.date?.start ?? "";
  }

  return "";
}

function statusSnapshot(record) {
  return (record.status || "").trim();
}

function daysUntilBirthday(dateStr) {
  const birthday = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const nextBirthday = new Date(today.getFullYear(), birthday.getMonth(), birthday.getDate());

  if (nextBirthday < today) {
    nextBirthday.setFullYear(today.getFullYear() + 1);
  }

  return Math.round((nextBirthday - today) / 86400000);
}

function mediaStatusText(record) {
  const hasGift = Boolean(record.giftIdea && record.giftIdea.trim());
  const baseStatus = hasGift ? "ідею вже додано" : "подарунок ще не обрано";
  const notionStatus = statusSnapshot(record);

  if (!notionStatus || notionStatus.toLowerCase() === baseStatus.toLowerCase()) {
    return baseStatus;
  }

  return `${baseStatus}, [${notionStatus}]`;
}

function mediaReminderCopy() {
  return "Не відкладай на останній момент — зазирни до контактів і знайди ідею, яка точно потрапить у серце 🎁";
}

function mediaReminderTitle(record, daysAhead) {
  if (daysAhead === 0) {
    return `🎉 Сьогодні день народження у *${record.name}*`;
  }

  return `🎂 ${timingText(daysAhead)} — день народження у *${record.name}*`;
}

function buildMediaMessage(record, daysAhead) {
  const dateFormatted = formatDate(record.birthday);
  const status = mediaStatusText(record);
  const plainTitle = mediaReminderTitle(record, daysAhead).replace(/\*/g, "");
  const text = `${plainTitle}. Статус: ${status}`;

  return {
    text,
    blocks: [
      {
        type: "section",
        text: mrkdwnBlock(mediaReminderTitle(record, daysAhead)),
      },
      {
        type: "section",
        text: mrkdwnBlock(`📅 Дата: ${dateFormatted}\nСтатус: ${status}`),
      },
      {
        type: "section",
        text: mrkdwnBlock(mediaReminderCopy()),
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: plainTextBlock("Контакти та ідеї"),
            url: record.url || NOTION_DB_URL,
            style: "primary",
          },
        ],
      },
    ],
  };
}

function buildCeoMessage(record, daysAhead, ceoMention) {
  const dateFormatted = formatDate(record.birthday);
  const title = `🎂 ${timingText(daysAhead)} — день народження партнера CEO · *${record.name}*`;
  const copy = "Саме час подбати про привітання! Якщо потрібен подарунок від дизайнера — створи таску заздалегідь, щоб все встигли підготувати:";
  const text = `${ceoMention} ${title.replace(/\*/g, "")}. ${dateFormatted}. ${copy} ${DESIGN_TASK_BOT_URL}`;

  return {
    text,
    blocks: [
      {
        type: "section",
        text: mrkdwnBlock(title),
      },
      {
        type: "section",
        text: mrkdwnBlock(`📅 ${dateFormatted}`),
      },
      {
        type: "section",
        text: mrkdwnBlock(`${ceoMention} ${copy}`),
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: plainTextBlock("Створити дизайн-таску"),
            url: DESIGN_TASK_BOT_URL,
            style: "primary",
          },
        ],
      },
    ],
  };
}

function buildSlackMessage(record, daysAhead, ceoMention) {
  if (record.ceo) {
    return buildCeoMessage(record, daysAhead, ceoMention);
  }

  return buildMediaMessage(record, daysAhead);
}

function formatSlackUserMention(userId) {
  const trimmed = (userId || "").trim();
  if (!trimmed) return "";
  const rawUserId = trimmed.startsWith("<@") && trimmed.endsWith(">")
    ? trimmed.slice(2, -1).split("|")[0]
    : trimmed;
  if (/^[UW][A-Z0-9]+$/.test(rawUserId)) return `<@${rawUserId}>`;
  return "";
}

async function resolveCeoSlackMention() {
  if (cachedCeoMention) return cachedCeoMention;

  const configuredMention = formatSlackUserMention(CEO_SLACK_USER_ID);
  if (configuredMention) {
    cachedCeoMention = configuredMention;
    return cachedCeoMention;
  }

  try {
    if (CEO_SLACK_DM_CHANNEL) {
      const response = await slack.conversations.info({ channel: CEO_SLACK_DM_CHANNEL });
      const userId = response.channel?.user;
      const mention = formatSlackUserMention(userId);
      if (mention) {
        cachedCeoMention = mention;
        return cachedCeoMention;
      }
    }
  } catch (err) {
    console.warn(`Не вдалося отримати Slack user id із DM-каналу ${CEO_SLACK_DM_CHANNEL}: ${err.message}`);
  }

  try {
    const response = await slack.users.list({ limit: 200 });
    const normalizedTarget = CEO_SLACK_DISPLAY_NAME.toLowerCase();
    const user = response.members?.find((member) => {
      const profile = member.profile || {};
      return [
        profile.real_name,
        profile.display_name,
        member.real_name,
        member.name,
      ]
        .filter(Boolean)
        .some((name) => name.toLowerCase() === normalizedTarget);
    });
    const mention = formatSlackUserMention(user?.id);
    if (mention) {
      cachedCeoMention = mention;
      return cachedCeoMention;
    }
  } catch (err) {
    console.warn(`Не вдалося знайти ${CEO_SLACK_DISPLAY_NAME} у Slack users.list: ${err.message}`);
  }

  cachedCeoMention = `@${CEO_SLACK_DISPLAY_NAME}`;
  return cachedCeoMention;
}

async function ensureTrackingProperties() {
  if (trackingPropertiesEnsured) return true;

  try {
    const database = await withNotionRetry("отримання структури бази", () => notion.databases.retrieve({
      database_id: NOTION_DATABASE_ID,
    }));
    const missingProperties = {};

    for (const propertyName of Object.values(TRACKING_PROPERTIES)) {
      if (!database.properties[propertyName]) {
        missingProperties[propertyName] = { rich_text: {} };
      }
    }

    if (Object.keys(missingProperties).length) {
      await withNotionRetry("оновлення структури бази", () => notion.databases.update({
        database_id: NOTION_DATABASE_ID,
        properties: missingProperties,
      }));
      console.log(`Додано службові Notion-поля: ${Object.keys(missingProperties).join(", ")}`);
    }

    trackingPropertiesEnsured = true;
    return true;
  } catch (err) {
    console.warn(`Не вдалося автоматично підготувати службові Notion-поля: ${err.message}`);
    console.warn(`Якщо поля вже створені вручну, бот все одно спробує записати Slack tracking.`);
    trackingPropertiesEnsured = true;
    return true;
  }
}

async function updateTrackingProperties(record, values) {
  const properties = {
    [TRACKING_PROPERTIES.messageTs]: richTextProperty(values.messageTs),
    [TRACKING_PROPERTIES.messageChannel]: richTextProperty(values.messageChannel),
    [TRACKING_PROPERTIES.reminderKey]: richTextProperty(values.reminderKey),
    [TRACKING_PROPERTIES.reminderDays]: richTextProperty(values.reminderDays),
    [TRACKING_PROPERTIES.statusSnapshot]: richTextProperty(values.statusSnapshot),
  };

  await withNotionRetry(`оновлення tracking для ${record.name}`, () => notion.pages.update({
    page_id: record.id,
    properties,
  }));
}

async function tryUpdateTrackingProperties(record, values) {
  try {
    await updateTrackingProperties(record, values);
    return true;
  } catch (err) {
    console.warn(`Не вдалося записати Slack tracking для ${record.name}: ${err.message}`);
    return false;
  }
}

async function fetchBirthdays() {
  const results = [];
  let cursor = undefined;

  do {
    const response = await withNotionRetry("читання записів бази", () => notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
    }));

    for (const page of response.results) {
      const props = page.properties;
      const birthdayDate = props["Дата ДН"]?.date?.start ?? null;
      if (!birthdayDate) continue;

      results.push({
        id: page.id,
        url: page.url,
        name: props["Імʼя"]?.title?.[0]?.plain_text ?? "—",
        company: props["Компанія"]?.rich_text?.[0]?.plain_text ?? "",
        position: props["Посада"]?.rich_text?.[0]?.plain_text ?? "",
        budget: props["Бюджет план"]?.rich_text?.[0]?.plain_text ?? "",
        giftIdea: props["Ідея подарунку"]?.rich_text?.[0]?.plain_text ?? "",
        status: getPropertyText(props["Status"] || props["Статус"]),
        ceo: props["CEO"]?.checkbox ?? false,
        birthday: birthdayDate,
        monthDay: toMonthDay(birthdayDate),
        slackMessageTs: getPropertyText(props[TRACKING_PROPERTIES.messageTs]),
        slackMessageChannel: getPropertyText(props[TRACKING_PROPERTIES.messageChannel]),
        slackReminderKey: getPropertyText(props[TRACKING_PROPERTIES.reminderKey]),
        slackReminderDays: getPropertyText(props[TRACKING_PROPERTIES.reminderDays]),
        slackStatusSnapshot: getPropertyText(props[TRACKING_PROPERTIES.statusSnapshot]),
      });
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return results;
}

function findRecordByName(records, targetName) {
  const normalizedTarget = targetName.trim().toLowerCase();
  const exactMatches = records.filter((record) => record.name.trim().toLowerCase() === normalizedTarget);
  if (exactMatches.length) return exactMatches[0];

  return records.find((record) => record.name.trim().toLowerCase().includes(normalizedTarget));
}

async function postOrUpdateReminder(record, daysAhead, ceoMention, trackingEnabled, options = {}) {
  const message = buildSlackMessage(record, daysAhead, ceoMention);
  const key = options.reminderDate
    ? reminderKeyForDate(options.reminderDate, daysAhead)
    : reminderKey(daysAhead);
  const trackedMessageIsCurrent = options.updateExisting && trackingEnabled && record.slackMessageTs && record.slackReminderKey === key;

  if (trackedMessageIsCurrent) {
    const channel = record.slackMessageChannel || SLACK_CHANNEL;
    await slack.chat.update({
      channel,
      ts: record.slackMessageTs,
      text: message.text,
      blocks: message.blocks,
      link_names: true,
    });
    await tryUpdateTrackingProperties(record, {
      messageTs: record.slackMessageTs,
      messageChannel: channel,
      reminderKey: key,
      reminderDays: String(daysAhead),
      statusSnapshot: statusSnapshot(record),
    });
    return "updated";
  }

  const response = await slack.chat.postMessage({
    channel: SLACK_CHANNEL,
    text: message.text,
    blocks: message.blocks,
    link_names: true,
  });

  if (trackingEnabled && response.ts) {
    await tryUpdateTrackingProperties(record, {
      messageTs: response.ts,
      messageChannel: SLACK_CHANNEL,
      reminderKey: key,
      reminderDays: String(daysAhead),
      statusSnapshot: statusSnapshot(record),
    });
  }

  return "sent";
}

async function checkAndNotify() {
  console.log(`[${new Date().toISOString()}] Перевіряємо дні народження...`);

  const trackingEnabled = await ensureTrackingProperties();
  const records = await fetchBirthdays();
  const targetDays = [0, 3, 5, 10];
  let sent = 0;
  let updated = 0;
  let ceoMention = "";

  for (const daysAhead of targetDays) {
    const target = getTargetMonthDay(daysAhead);
    const matches = records.filter((r) => r.monthDay === target);

    for (const record of matches) {
      try {
        if (record.ceo && !ceoMention) {
          ceoMention = await resolveCeoSlackMention();
        }
        await waitBeforeNextSlackPost(sent > 0);
        const result = await postOrUpdateReminder(record, daysAhead, ceoMention, trackingEnabled);
        if (result === "updated") {
          updated++;
          console.log(`↻ Оновлено: ${record.name} (за ${daysAhead} днів, channel ${SLACK_CHANNEL})`);
        } else {
          sent++;
          console.log(`✓ Надіслано: ${record.name} (за ${daysAhead} днів, channel ${SLACK_CHANNEL})`);
        }
      } catch (err) {
        console.error(`✗ Помилка для ${record.name}:`, err.message);
      }
    }
  }

  console.log(`Готово. Надіслано ${sent} повідомлень, оновлено ${updated}.`);
}

async function sendTestRecordNotification() {
  const recordName = process.env.TEST_RECORD_NAME || getArgValue("--test-record");
  const requestedDaysAhead = process.env.TEST_DAYS_AHEAD || getArgValue("--test-days");

  if (!recordName) {
    throw new Error("Для тесту вкажіть назву запису через --test-record або TEST_RECORD_NAME.");
  }

  console.log(`[${new Date().toISOString()}] Шукаємо тестовий запис: ${recordName}`);

  const trackingEnabled = await ensureTrackingProperties();
  const records = await fetchBirthdays();
  const record = findRecordByName(records, recordName);

  if (!record) {
    throw new Error(`Не знайдено запис у Notion за назвою: ${recordName}`);
  }

  const parsedDaysAhead = Number(requestedDaysAhead);
  const daysAhead = Number.isFinite(parsedDaysAhead) ? parsedDaysAhead : daysUntilBirthday(record.birthday);
  const ceoMention = record.ceo ? await resolveCeoSlackMention() : "";
  const result = await postOrUpdateReminder(record, daysAhead, ceoMention, trackingEnabled);

  console.log(`Готово. Тестове повідомлення для "${record.name}" ${result === "updated" ? "оновлено" : "надіслано"} (daysAhead=${daysAhead}).`);
}

function parseSlackMessageRef(ref) {
  const trimmed = (ref || "").trim();
  if (!trimmed) return null;

  const urlMatch = trimmed.match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
  if (urlMatch) {
    return { channel: urlMatch[1], ts: `${urlMatch[2]}.${urlMatch[3]}` };
  }

  const explicitMatch = trimmed.match(/^([A-Z0-9]+)[/:](\d{10})(?:\.?)(\d{6})$/);
  if (explicitMatch) {
    return { channel: explicitMatch[1], ts: `${explicitMatch[2]}.${explicitMatch[3]}` };
  }

  return null;
}

function parseList(value) {
  return (value || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function deleteSlackMessages(messageRefs) {
  let deleted = 0;

  for (const ref of messageRefs) {
    const message = parseSlackMessageRef(ref);
    if (!message) {
      console.warn(`Пропущено некоректний Slack message ref: ${ref}`);
      continue;
    }

    try {
      await slack.chat.delete({
        channel: message.channel,
        ts: message.ts,
      });
      deleted++;
      console.log(`✓ Видалено Slack-повідомлення ${message.channel}/${message.ts}`);
    } catch (err) {
      const slackError = err.data?.error || err.message;
      if (slackError === "message_not_found") {
        console.warn(`Повідомлення вже не знайдено: ${message.channel}/${message.ts}`);
        continue;
      }
      throw new Error(`Не вдалося видалити ${message.channel}/${message.ts}: ${slackError}`);
    }
  }

  return deleted;
}

async function deleteSlackMessagesOnly() {
  const deleteMessageRefs = parseList(process.env.DELETE_MESSAGES || getArgValue("--delete-messages"));

  if (!deleteMessageRefs.length) {
    throw new Error("Для delete-режиму передайте Slack message URLs через --delete-messages або DELETE_MESSAGES.");
  }

  const deleted = await deleteSlackMessages(deleteMessageRefs);
  console.log(`Готово. Видалено повідомлень: ${deleted}.`);
}

async function repairSlackMessages() {
  const repairDate = process.env.REPAIR_DATE || getArgValue("--repair-date");
  const repairDays = parseList(process.env.REPAIR_DAYS || getArgValue("--repair-days") || "0,10").map(Number);
  const deleteMessageRefs = parseList(process.env.REPAIR_DELETE_MESSAGES || getArgValue("--delete-messages"));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(repairDate)) {
    throw new Error("Для repair-режиму вкажіть дату у форматі YYYY-MM-DD через --repair-date або REPAIR_DATE.");
  }

  if (!repairDays.length || repairDays.some((daysAhead) => !Number.isFinite(daysAhead))) {
    throw new Error("Для repair-режиму вкажіть коректні дні через --repair-days або REPAIR_DAYS, наприклад 0,10.");
  }

  console.log(`[${new Date().toISOString()}] Repair Slack messages for ${repairDate}; days=${repairDays.join(",")}`);

  if (deleteMessageRefs.length) {
    const deleted = await deleteSlackMessages(deleteMessageRefs);
    console.log(`Видалено повідомлень: ${deleted}.`);
  }

  const trackingEnabled = await ensureTrackingProperties();
  const records = await fetchBirthdays();
  let sent = 0;
  let ceoMention = "";

  for (const daysAhead of repairDays) {
    const targetDate = addDaysToIsoDate(repairDate, daysAhead);
    const targetMonthDay = targetDate.slice(5);
    const matches = records.filter((record) => record.monthDay === targetMonthDay);

    if (!matches.length) {
      console.warn(`Не знайдено записів для ${targetDate} (за ${daysAhead} днів від ${repairDate}).`);
      continue;
    }

    for (const record of matches) {
      if (record.ceo && !ceoMention) {
        ceoMention = await resolveCeoSlackMention();
      }

      await waitBeforeNextSlackPost(sent > 0);
      await postOrUpdateReminder(record, daysAhead, ceoMention, trackingEnabled, {
        reminderDate: targetDate,
      });
      sent++;
      console.log(`✓ Перевідправлено: ${record.name} (target ${targetDate}, daysAhead=${daysAhead})`);
    }
  }

  console.log(`Repair завершено. Перевідправлено повідомлень: ${sent}.`);
}

async function syncTrackedStatuses() {
  console.log(`[${new Date().toISOString()}] Перевіряємо зміни статусів...`);

  const trackingEnabled = await ensureTrackingProperties();
  if (!trackingEnabled) {
    console.log("Службові поля недоступні, статуси не оновлено.");
    return;
  }

  const records = await fetchBirthdays();
  let updated = 0;

  for (const record of records) {
    if (record.ceo || !record.slackMessageTs) continue;

    const currentStatus = statusSnapshot(record);
    const previousStatus = record.slackStatusSnapshot || "";
    if (currentStatus === previousStatus) continue;

    const daysAhead = Number(record.slackReminderDays);
    if (!Number.isFinite(daysAhead)) {
      console.warn(`Пропущено ${record.name}: некоректне значення ${TRACKING_PROPERTIES.reminderDays}`);
      continue;
    }

    const message = buildSlackMessage(record, daysAhead, "");
    const channel = record.slackMessageChannel || SLACK_CHANNEL;

    try {
      await slack.chat.update({
        channel,
        ts: record.slackMessageTs,
        text: message.text,
        blocks: message.blocks,
        link_names: true,
      });
      await tryUpdateTrackingProperties(record, {
        messageTs: record.slackMessageTs,
        messageChannel: channel,
        reminderKey: record.slackReminderKey,
        reminderDays: record.slackReminderDays,
        statusSnapshot: currentStatus,
      });
      updated++;
      console.log(`↻ Статус оновлено в Slack: ${record.name} → ${currentStatus || "без статусу"}`);
    } catch (err) {
      console.error(`✗ Не вдалося оновити статус для ${record.name}:`, err.message);
    }
  }

  console.log(`Готово. Оновлено статусів: ${updated}.`);
}

if (process.argv.includes("--test-record")) {
  sendTestRecordNotification().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (process.argv.includes("--repair-messages")) {
  repairSlackMessages().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (process.argv.includes("--delete-messages")) {
  deleteSlackMessagesOnly().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (process.argv.includes("--sync-statuses")) {
  syncTrackedStatuses().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (process.argv.includes("--run-once")) {
  checkAndNotify().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  cron.schedule("0 8 * * *", () => {
    checkAndNotify().catch(console.error);
  }, { timezone: "UTC" });

  cron.schedule("*/10 * * * *", () => {
    syncTrackedStatuses().catch(console.error);
  }, { timezone: "UTC" });

  console.log("Birthday bot запущено. Очікуємо 11:00 Київ (08:00 UTC)...");
}
