const { getConfigItem } = require('./config');

const LLMEnabled = () => {
    const GROQ_API_KEY = getConfigItem('GROQ_API_KEY');
    return typeof GROQ_API_KEY == 'string' && GROQ_API_KEY.length > 0;
}

const queryLLM = async (prompt) => {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getConfigItem('GROQ_API_KEY')}`, 
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',  
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
    })
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
};

module.exports.queryLLM = queryLLM;
module.exports.LLMEnabled = LLMEnabled;