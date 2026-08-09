const { getConfigItem } = require('./config');

const DEFAULT_SCENARIOS = [
  {
    id: 'casual_chat',
    name: 'Casual chat',
    description: 'Relaxed everyday conversation; keep it light and natural.',
  },
  {
    id: 'discussion_lead',
    name: 'Lead discussion',
    description: 'Gently steer the thread, ask follow-ups, keep people engaged.',
  },
  {
    id: 'supportive',
    name: 'Supportive / cheer up',
    description: 'Warm, empathetic, encouraging tone; help improve mood.',
  },
  {
    id: 'icebreaker',
    name: 'Icebreaker',
    description: 'Get familiar with the person; learn a bit about them for better chat.',
  },
  {
    id: 'celebrate',
    name: 'Celebrate / congratulate',
    description: 'Congratulate or celebrate something with genuine enthusiasm.',
  },
  {
    id: 'humor',
    name: 'Humor',
    description: 'Lean into jokes and playful remarks without forcing them every turn.',
  },
];

const DEFAULT_GOALS = [
  {
    id: 'make_laugh',
    name: 'Make them laugh',
    description: 'Aim to make the other person smile or laugh.',
  },
  {
    id: 'boost_mood',
    name: 'Boost mood',
    description: 'Help improve someone\'s mood like a supportive friend (not clinical therapy).',
  },
  {
    id: 'greet',
    name: 'Greet',
    description: 'Greet someone warmly and open a conversation.',
  },
  {
    id: 'congratulate',
    name: 'Congratulate',
    description: 'Congratulate someone on an achievement or occasion.',
  },
  {
    id: 'get_familiar',
    name: 'Get familiar',
    description: 'Learn about the person\'s personality to build a more relevant conversation.',
  },
  {
    id: 'stay_engaged',
    name: 'Stay engaged',
    description: 'Keep the discussion alive with relevant replies and questions.',
  },
];

const DEFAULT_CONVERSATION_STYLE = [
  'Sound like a real person in a group chat, not a scripted assistant.',
  'Occasionally skip a turn (skip=true) so the conversation does not feel robotic.',
  'You may briefly digress or inject a light joke/aside, then return to the scenario/goal.',
  'Vary reply length and energy; do not always complete the whole goal in one message.',
  'Prefer answering unanswered replies to your messages when that feels natural.',
  'Never announce that you are following a scenario, mood, or goal.',
].join('\n');

const REPLY_STRATEGIES = [
  { id: 'auto', name: 'Auto (prefer unanswered replies to us, else root)' },
  { id: 'root', name: 'Discussion root' },
  { id: 'unanswered_to_us', name: 'Unanswered replies to our messages' },
  { id: 'any_thread', name: 'Any message in thread (LLM chooses)' },
  { id: 'last', name: 'Latest message' },
  { id: 'random', name: 'Random message' },
];

const PM_MODES = [
  { id: 'off', name: 'Off (do not reply to private chats)' },
  { id: 'autoreply', name: 'Static autoreply text' },
  { id: 'ai', name: 'AI chatting (full flow)' },
];

const DEFAULT_PM_PROMPT =
  'Continue this private Telegram chat naturally as yourself. Reply to the latest incoming message.';

function LLMEnabled() {
  const GROQ_API_KEY = getConfigItem('GROQ_API_KEY');
  return typeof GROQ_API_KEY === 'string' && GROQ_API_KEY.length > 0;
}

function parseCatalog(raw, fallback) {
  if (!raw || (typeof raw === 'string' && !raw.trim())) {
    return fallback.map((item) => ({ ...item }));
  }
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed) || !parsed.length) {
      return fallback.map((item) => ({ ...item }));
    }
    return parsed
      .filter((item) => item && item.id)
      .map((item) => ({
        id: String(item.id),
        name: String(item.name || item.id),
        description: String(item.description || ''),
      }));
  } catch {
    return fallback.map((item) => ({ ...item }));
  }
}

function getScenarios() {
  return parseCatalog(getConfigItem('AI_SCENARIOS'), DEFAULT_SCENARIOS);
}

function getGoals() {
  return parseCatalog(getConfigItem('AI_GOALS'), DEFAULT_GOALS);
}

function findCatalogEntry(catalog, id) {
  if (!id) return null;
  return catalog.find((item) => item.id === id) || null;
}

function pickOverride(itemValue, globalValue) {
  if (typeof itemValue === 'string' && itemValue.trim()) return itemValue.trim();
  if (typeof globalValue === 'string' && globalValue.trim()) return globalValue.trim();
  return '';
}

function buildAiContext(item = {}) {
  const scenarios = getScenarios();
  const goals = getGoals();
  const scenario = findCatalogEntry(scenarios, item.ai_scenario);
  const goal = findCatalogEntry(goals, item.ai_goal);

  return {
    personality: pickOverride(item.ai_personality, getConfigItem('AI_PERSONALITY')),
    bio: pickOverride(item.ai_bio, getConfigItem('AI_BIO')),
    mood: pickOverride(item.ai_mood, getConfigItem('AI_MOOD')),
    scenarioId: item.ai_scenario || '',
    scenario,
    goalId: item.ai_goal || '',
    goal,
    replyStrategy:
      pickOverride(item.reply_strategy, getConfigItem('AI_REPLY_STRATEGY')) || 'auto',
    conversationStyle:
      pickOverride(null, getConfigItem('AI_CONVERSATION_STYLE')) || DEFAULT_CONVERSATION_STYLE,
    baseSystem: pickOverride(null, getConfigItem('GROQ_SYSTEM_MESSAGE')),
    chatType: item.chat_type || 'discussion',
  };
}

function buildPmAiContext() {
  return buildAiContext({
    chat_type: 'private',
    ai_scenario: getConfigItem('AI_PM_SCENARIO') || '',
    ai_goal: getConfigItem('AI_PM_GOAL') || '',
    ai_mood: getConfigItem('AI_PM_MOOD') || '',
    ai_personality: getConfigItem('AI_PM_PERSONALITY') || '',
    ai_bio: getConfigItem('AI_PM_BIO') || '',
  });
}

function resolvePmMode() {
  const mode = String(getConfigItem('TELEGRAM_PM_MODE') || '')
    .trim()
    .toLowerCase();
  if (mode === 'ai' || mode === 'autoreply' || mode === 'off') return mode;
  // Backward compatible: static text alone enables autoreply
  if (getConfigItem('TELEGRAM_PM_AUTOREPLY_TEXT')) return 'autoreply';
  return 'off';
}

function getPmPrompt() {
  return pickOverride(getConfigItem('AI_PM_PROMPT'), DEFAULT_PM_PROMPT);
}

function buildSystemPrompt(aiContext = {}) {
  const parts = [];

  if (aiContext.baseSystem) {
    parts.push(aiContext.baseSystem);
  }

  const chatIntro =
    aiContext.chatType === 'private'
      ? 'You are chatting in a private Telegram 1:1 conversation as a real user account.'
      : 'You are participating in a Telegram discussion as a real user account.';

  parts.push(
    [
      chatIntro,
      'Respond with either plain text, or a JSON object:',
      '{"skip":boolean,"answer":string,"message_id":number|null}',
      'Use skip=true when staying silent feels more natural.',
      'Use message_id to reply to a specific message from INPUT when allowed.',
    ].join('\n')
  );

  if (aiContext.personality) {
    parts.push(`Personality:\n${aiContext.personality}`);
  }
  if (aiContext.bio) {
    parts.push(`Bio / background:\n${aiContext.bio}`);
  }
  if (aiContext.mood) {
    parts.push(`Current mood:\n${aiContext.mood}`);
  }
  if (aiContext.scenario) {
    parts.push(
      `Active scenario (soft guidance, not a rigid script):\n` +
        `${aiContext.scenario.name}: ${aiContext.scenario.description}`
    );
  }
  if (aiContext.goal) {
    parts.push(
      `Active goal (steer toward it gradually):\n` +
        `${aiContext.goal.name}: ${aiContext.goal.description}`
    );
  }
  if (aiContext.conversationStyle) {
    parts.push(`Conversation style:\n${aiContext.conversationStyle}`);
  }
  if (aiContext.replyStrategy) {
    parts.push(`Reply strategy hint: ${aiContext.replyStrategy}`);
  }

  return parts.filter(Boolean).join('\n\n');
}

function getAiCatalog() {
  return {
    scenarios: getScenarios(),
    goals: getGoals(),
    replyStrategies: REPLY_STRATEGIES,
    pmModes: PM_MODES,
    defaults: {
      scenarios: DEFAULT_SCENARIOS,
      goals: DEFAULT_GOALS,
      conversationStyle: DEFAULT_CONVERSATION_STYLE,
      pmPrompt: DEFAULT_PM_PROMPT,
    },
  };
}

function shouldOccasionallySkip() {
  const raw = getConfigItem('AI_SKIP_PROBABILITY');
  const p = Math.min(100, Math.max(0, parseFloat(raw || '0') || 0));
  return p > 0 && Math.random() * 100 < p;
}

async function maybeAiReplyDelay(sleepFn) {
  const min = Math.max(0, parseInt(getConfigItem('AI_REPLY_DELAY_MIN_MS') || '0', 10) || 0);
  const max = Math.max(0, parseInt(getConfigItem('AI_REPLY_DELAY_MAX_MS') || '0', 10) || 0);
  if (max <= 0) return;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const ms = lo + Math.floor(Math.random() * (hi - lo + 1));
  if (ms > 0 && typeof sleepFn === 'function') {
    console.log(`⏳ AI reply delay ${ms}ms`);
    await sleepFn(ms);
  }
}

const queryLLM = async (prompt, retries = 2, aiContext = null) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const messages = [
      {
        role: 'user',
        content: prompt,
      },
    ];

    const systemContent = aiContext
      ? buildSystemPrompt(aiContext)
      : getConfigItem('GROQ_SYSTEM_MESSAGE');

    if (systemContent) {
      messages.unshift({
        role: 'system',
        content: systemContent,
      });
    }

    const response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getConfigItem('GROQ_API_KEY')}`,
        },
        body: JSON.stringify({
          model: getConfigItem('GROQ_API_MODEL') || 'llama-3.3-70b-versatile',
          messages,
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Groq API ${response.status}: ${text}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? '';
  } catch (err) {
    if (retries > 0) {
      console.warn(`⚠️ LLM retry (${3 - retries}/3):`, err.code || err.name);
      await new Promise((r) => setTimeout(r, 1000));
      return queryLLM(prompt, retries - 1, aiContext);
    }

    console.error('❌ LLM failed permanently:', err);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
};

module.exports.queryLLM = queryLLM;
module.exports.LLMEnabled = LLMEnabled;
module.exports.buildAiContext = buildAiContext;
module.exports.buildPmAiContext = buildPmAiContext;
module.exports.buildSystemPrompt = buildSystemPrompt;
module.exports.getAiCatalog = getAiCatalog;
module.exports.getScenarios = getScenarios;
module.exports.getGoals = getGoals;
module.exports.resolvePmMode = resolvePmMode;
module.exports.getPmPrompt = getPmPrompt;
module.exports.shouldOccasionallySkip = shouldOccasionallySkip;
module.exports.maybeAiReplyDelay = maybeAiReplyDelay;
module.exports.DEFAULT_SCENARIOS = DEFAULT_SCENARIOS;
module.exports.DEFAULT_GOALS = DEFAULT_GOALS;
module.exports.DEFAULT_CONVERSATION_STYLE = DEFAULT_CONVERSATION_STYLE;
module.exports.DEFAULT_PM_PROMPT = DEFAULT_PM_PROMPT;
module.exports.REPLY_STRATEGIES = REPLY_STRATEGIES;
module.exports.PM_MODES = PM_MODES;
