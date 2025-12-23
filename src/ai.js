const { getConfigItem } = require('./config');

const LLMEnabled = () => {
    const GROQ_API_KEY = getConfigItem('GROQ_API_KEY');
    return typeof GROQ_API_KEY == 'string' && GROQ_API_KEY.length > 0;
}

const queryLLM = async (prompt, retries = 2) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    let messages = [
      {
        role: 'user',
        content: prompt,
      }
    ];
    if (getConfigItem('GROQ_SYSTEM_MESSAGE')) {
        messages = [
          {
            role: 'system',
            content: getConfigItem('GROQ_SYSTEM_MESSAGE'),
          },
          ...messages,
        ];
    }

    const response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getConfigItem('GROQ_API_KEY')}`,
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
      await new Promise(r => setTimeout(r, 1000));
      return queryLLM(prompt, retries - 1);
    }

    console.error('❌ LLM failed permanently:', err);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
};


module.exports.queryLLM = queryLLM;
module.exports.LLMEnabled = LLMEnabled;