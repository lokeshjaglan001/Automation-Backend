// services/llmService.js
import { GoogleGenerativeAI } from '@google/generative-ai';


class LLMService {
  constructor() {
    if (!process.env.GEMINI_API_KEY) {
      console.warn('GEMINI_API_KEY not found in environment variables');
    }
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }

  async callGemini(taskDescription, modelName, retries = 3, delay = 30000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const model = this.genAI.getGenerativeModel({ model: modelName });

        const prompt = `${this.generateSystemPrompt()}

Task to automate: "${taskDescription}"

Remember: Return ONLY valid JSON, no markdown formatting, no code blocks.`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        return text;
      } catch (error) {
        if (error.status === 503 && attempt < retries) {
          console.warn(`Gemini API 503 error on attempt ${attempt}, retrying in ${delay / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue; // Retry after delay
        }
        console.error('Gemini API error:', error);
        throw new Error(`Failed to call Gemini API: ${error.message}`);
      }
    }
  }

  // Analyze task complexity and select appropriate Gemini model
  selectModel(taskDescription) {
    const complexity = this.analyzeComplexity(taskDescription);

    switch (complexity) {
      case 'easy':
        return 'gemini-2.5-flash'; // Fast and efficient for simple tasks
      case 'intermediate':
        return 'gemini-2.5-flash'; // Good balance
      case 'complex':
        return 'gemini-2.5-pro'; // Best reasoning for complex tasks
      default:
        return 'gemini-2.5-flash';
    }
  }

  // Simple complexity analyzer
  analyzeComplexity(taskDescription) {
    const text = taskDescription.toLowerCase();

    // Complex patterns
    const complexPatterns = [
      'analyze', 'compare', 'calculate', 'process data', 'machine learning',
      'ai', 'complex logic', 'multiple conditions', 'workflow', 'integration',
      'transform', 'parse', 'extract and process'
    ];

    // Easy patterns
    const easyPatterns = [
      'send email', 'post message', 'simple notification', 'basic alert',
      'reminder', 'daily message', 'weekly update', 'fetch data'
    ];

    const complexScore = complexPatterns.filter(pattern => text.includes(pattern)).length;
    const easyScore = easyPatterns.filter(pattern => text.includes(pattern)).length;

    if (complexScore >= 2) return 'complex';
    if (easyScore >= 1 && complexScore === 0) return 'easy';
    return 'intermediate';
  }

  // Generate system prompt for n8n workflow creation
  generateSystemPrompt() {
    return `You are an AI assistant that converts natural language task descriptions into executable n8n workflow JSON.

Your task is to:
1. Analyze if the task is automatable with n8n
2. If automatable, generate a valid n8n workflow JSON
3. If not automatable, return an error response

IMPORTANT RULES:
- Only return valid JSON (no markdown, no code blocks, just pure JSON)
- Use realistic node configurations
- Include proper node connections
- Handle authentication requirements
- Provide meaningful node names and descriptions

RESPONSE FORMAT:
For automatable tasks, return:
{
  "automatable": true,
  "workflow": {
    "name": "Task Name",
    "nodes": [
      {
        "id": "unique_id",
        "name": "Node Name",
        "type": "n8n-nodes-base.nodeName",
        "typeVersion": 1,
        "position": [x, y],
        "parameters": {
          // node-specific parameters
        }
      }
    ],
    "connections": {
      "node_id": {
        "main": [
          [
            {
              "node": "target_node_id",
              "type": "main",
              "index": 0
            }
          ]
        ]
      }
    }
  },
  "description": "Brief description of what this workflow does",
  "requirements": ["List of required credentials/setup"]
}

For non-automatable tasks, return:
{
  "automatable": false,
  "reason": "Explanation of why this cannot be automated",
  "suggestions": ["Alternative approaches or manual steps"]
}

AVAILABLE n8n NODES (most common):
- HTTP Request: n8n-nodes-base.httpRequest
- Email Send: n8n-nodes-base.emailSend
- Schedule Trigger: n8n-nodes-base.scheduleTrigger
- Manual Trigger: n8n-nodes-base.manualTrigger
- Slack: n8n-nodes-base.slack
- Discord: n8n-nodes-base.discord
- Google Sheets: n8n-nodes-base.googleSheets
- Webhook: n8n-nodes-base.webhook
- Code: n8n-nodes-base.code
- Set: n8n-nodes-base.set
- IF: n8n-nodes-base.if
- Switch: n8n-nodes-base.switch
- Merge: n8n-nodes-base.merge
- Split In Batches: n8n-nodes-base.splitInBatches

IMPORTANT: Return ONLY the JSON response. No explanations, no markdown formatting, no code blocks.`;
  }

  // Call Gemini API
  async callGemini(taskDescription, modelName) {
    try {
      const model = this.genAI.getGenerativeModel({ model: modelName });

      const prompt = `${this.generateSystemPrompt()}

Task to automate: "${taskDescription}"

Remember: Return ONLY valid JSON, no markdown formatting, no code blocks.`;

      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();

      return text;
    } catch (error) {
      console.error('Gemini API error:', error);
      throw new Error(`Failed to call Gemini API: ${error.message}`);
    }
  }

  // Main method to process task description
  async processTask(taskDescription) {
    try {
      console.log('Processing task:', taskDescription);

      // Select appropriate Gemini model
      const modelName = this.selectModel(taskDescription);
      console.log(`Selected Gemini model: ${modelName} for task processing`);

      // Call Gemini
      const response = await this.callGemini(taskDescription, modelName);
      console.log('Gemini Response:', response);

      // Parse and validate JSON response
      const parsedResponse = this.parseAndValidateResponse(response);

      return {
        success: true,
        provider: 'google',
        model: modelName,
        result: parsedResponse
      };

    } catch (error) {
      console.error('Error processing task:', error);
      return {
        success: false,
        error: error.message,
        result: {
          automatable: false,
          reason: 'Failed to process task with Gemini AI',
          suggestions: ['Please try rephrasing your task', 'Make your request more specific', 'Contact support if the issue persists']
        }
      };
    }
  }

  // Parse and validate LLM response
  parseAndValidateResponse(response) {
    try {
      // Clean the response (remove markdown formatting if present)
      let cleanedResponse = response
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      // Sometimes Gemini adds explanatory text before or after JSON
      // Try to extract JSON object from the response
      const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        cleanedResponse = jsonMatch[0];
      }

      // Parse JSON
      const parsed = JSON.parse(cleanedResponse);

      // Basic validation
      if (typeof parsed.automatable !== 'boolean') {
        throw new Error('Invalid response format: missing automatable field');
      }

      if (parsed.automatable && !parsed.workflow) {
        throw new Error('Invalid response format: missing workflow for automatable task');
      }

      if (!parsed.automatable && !parsed.reason) {
        throw new Error('Invalid response format: missing reason for non-automatable task');
      }

      return parsed;

    } catch (error) {
      console.error('Failed to parse Gemini response:', error);
      console.error('Raw response:', response);
      throw new Error(`Invalid JSON response from Gemini: ${error.message}`);
    }
  }

  // Test method to validate Gemini API connection
  async testConnection() {
    try {
      if (!process.env.GEMINI_API_KEY) {
        return {
          gemini: false,
          error: 'API key not configured'
        };
      }

      const model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const result = await model.generateContent('Hello, respond with "OK"');
      const response = await result.response;
      await response.text();

      return {
        gemini: true,
        model: 'gemini-2.5-flash'
      };
    } catch (error) {
      console.log('Gemini connection failed:', error.message);
      return {
        gemini: false,
        error: error.message
      };
    }
  }
}

export default LLMService;