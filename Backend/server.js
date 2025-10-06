import express from 'express';
import { PrismaClient } from '@prisma/client';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import authMiddleware from './middlewares/authmiddleware.js';
import LLMService from './services/llmServices.js';


const app = express();
const prisma = new PrismaClient();
const llmService = new LLMService();

app.use(express.json());
app.use(
  cors({
    origin: 'http://localhost:5173',
    credentials: true,
  })
);
app.use(cookieParser());

const authenticate = authMiddleware;

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const geminiStatus = await llmService.testConnection();
    res.json({
      status: 'healthy',
      database: 'connected',
      ai_provider: {
        name: 'Google Gemini',
        status: geminiStatus.gemini ? 'connected' : 'disconnected',
        model: geminiStatus.model || null,
        error: geminiStatus.error || null
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Home endpoint (protected)
app.get('/api/home', authenticate, (req, res) => {
  try {
    res.json({
      message: 'Protected home data',
      user: req.user,
    });
  } catch (error) {
    console.error('Error in /api/home:', error);
    res.status(500).json({ error: 'Failed to get home data', details: error.message });
  }
});

// User creation endpoint
app.post('/api/create', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const newUser = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
      },
    });

    const token = jwt.sign({ id: newUser.id, email: newUser.email }, process.env.JWT_SECRET, {
      expiresIn: '1d',
    });

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    });

    const { password: _, ...userWithoutPassword } = newUser;
    res.status(201).json(userWithoutPassword);
  } catch (error) {
    console.error('Database error in /api/create:', error);
    res.status(500).json({ error: 'Something went wrong', details: error.message });
  }
});

// Login endpoint
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, {
      expiresIn: '1d',
    });

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    });

    const { password: _, ...userWithoutPassword } = user;
    res.status(200).json(userWithoutPassword);
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Something went wrong', details: error.message });
  }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
  try {
    res.cookie('token', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 0,
    });
    res.status(200).json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed', details: error.message });
  }
});

// Delete account endpoint
app.delete('/api/delete', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    
    await prisma.task.deleteMany({
      where: { email: req.user.email }
    });
    
    await prisma.user.delete({
      where: { id: userId },
    });
    
    res.cookie('token', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 0,
    });
    
    res.status(200).json({ message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Delete error:', error);
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'User not found' });
    }
    res.status(500).json({ error: 'Something went wrong', details: error.message });
  }
});

// Get all users endpoint
app.get('/api/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
      },
    });
    res.json(users);
  } catch (err) {
    console.error('Database error in /api/users:', err);
    res.status(500).json({ error: 'Something went wrong', details: err.message });
  }
});

// Enhanced Create task endpoint with Gemini processing
app.post('/api/task', authenticate, async (req, res) => {
  let taskId = null;
  
  try {
    const { task, status, result, type, userId } = req.body;
    const email = req.user.email;

    if (!email) {
      return res.status(401).json({ error: 'Unauthorized: User not authenticated' });
    }
    if (!task || task.trim() === '') {
      return res.status(400).json({ error: 'Task content is required' });
    }
    if (task.trim().length < 3) {
      return res.status(400).json({ error: 'Task content must be at least 3 characters long' });
    }

    // Create task with initial status
    const newTask = await prisma.task.create({
      data: {
        email,
        task: task.trim(),
        status: 'pending',
        result: null,
        type: 'gemini_processing',
        userId,
      },
    });
    
    taskId = newTask.id;
    console.log('Task created:', newTask);

    // Respond immediately with created task
    res.status(201).json({ 
      message: 'Task created successfully, processing with Gemini AI...', 
      task: newTask 
    });

    // Process with Gemini asynchronously
    processTaskWithGemini(taskId, task.trim(), email);

  } catch (error) {
    console.error('Task Creation Error:', error);
    
    if (taskId) {
      try {
        await prisma.task.update({
          where: { id: taskId },
          data: { 
            status: 'failed',
            result: `Task creation failed: ${error.message}`,
            type: 'error'
          },
        });
      } catch (updateError) {
        console.error('Failed to update task status after error:', updateError);
      }
    }
    
    res.status(500).json({ error: 'Failed to create task', details: error.message });
  }
});

async function executeN8nWorkflow(workflow, taskId) {
  try {
    const n8nApiUrl = 'http://localhost:5678/api/v1/workflows';
    const n8nApiKey = process.env.N8N_API_KEY; // Add your n8n API key to .env

    if (!n8nApiKey) {
      throw new Error('N8N_API_KEY not configured in environment variables');
    }

    // Send workflow JSON to n8n API
    const response = await axios.post(
      n8nApiUrl,
      { ...workflow, active: true }, // Activate workflow immediately
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': n8nApiKey, // Or use basic auth if configured
        },
      }
    );

    console.log(`Workflow for task ${taskId} created in n8n:`, response.data);

    // Optionally, trigger the workflow immediately
    const workflowId = response.data.id;
    await axios.post(
      `http://localhost:5678/api/v1/workflows/${workflowId}/execute`,
      {},
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': n8nApiKey,
        },
      }
    );

    console.log(`Workflow ${workflowId} for task ${taskId} executed`);

    return { success: true, workflowId };
  } catch (error) {
    console.error(`Failed to create/execute n8n workflow for task ${taskId}:`, error.message);
    throw error;
  }
}

// Async function to process task with Gemini
async function processTaskWithGemini(taskId, taskDescription, email) {
  try {
    console.log(`Starting Gemini processing for task ${taskId}`);
    
    await prisma.task.update({
      where: { id: taskId },
      data: { 
        status: 'in-progress',
        type: 'gemini_processing'
      },
    });

    const geminiResult = await llmService.processTask(taskDescription);
    console.log(`Gemini processing result for task ${taskId}:`, JSON.stringify(geminiResult, null, 2));

    if (geminiResult.success && geminiResult.result.automatable) {
      // Create and execute workflow in n8n
      const n8nResult = await executeN8nWorkflow(geminiResult.result.workflow, taskId);

      await prisma.task.update({
        where: { id: taskId },
        data: { 
          status: 'completed',
          result: JSON.stringify({
            gemini_response: geminiResult.result,
            provider: 'google',
            model: geminiResult.model,
            workflow_generated: true,
            n8n_workflow_id: n8nResult.workflowId,
            timestamp: new Date().toISOString()
          }),
          type: 'automatable'
        },
      });
      
      console.log(`Task ${taskId} processed successfully - workflow generated and executed in n8n`);
      
    } else {
      const reason = geminiResult.result.reason || 'Gemini AI processing failed';
      await prisma.task.update({
        where: { id: taskId },
        data: { 
          status: 'failed',
          result: JSON.stringify({
            gemini_response: geminiResult.result,
            provider: 'google',
            model: geminiResult.model,
            reason: reason,
            timestamp: new Date().toISOString()
          }),
          type: 'not_automatable'
        },
      });
      
      console.log(`Task ${taskId} marked as not automatable: ${reason}`);
    }

  } catch (error) {
    console.error(`Error processing task ${taskId} with Gemini:`, error);
    
    try {
      await prisma.task.update({
        where: { id: taskId },
        data: { 
          status: 'failed',
          result: JSON.stringify({
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
          }),
          type: 'processing_error'
        },
      });
    } catch (updateError) {
      console.error(`Failed to update task ${taskId} status:`, updateError);
    }
  }
}

// Get tasks endpoint
app.get('/api/tasks', authenticate, async (req, res) => {
  try {
    const email = req.user?.email;
    if (!email) {
      return res.status(401).json({ error: 'Unauthorized: No email found in user session' });
    }
    
    const tasks = await prisma.task.findMany({
      where: { email },
      orderBy: { createdAt: 'desc' },
    });
    
    res.status(200).json({ tasks });
  } catch (error) {
    console.error('Tasks Fetch Error:', error);
    res.status(500).json({ error: 'Failed to fetch tasks', details: error.message });
  }
});

// Get single task with detailed information
app.get('/api/task/:id', authenticate, async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const email = req.user.email;

    const task = await prisma.task.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (task.email !== email) {
      return res.status(403).json({ error: 'Unauthorized to view this task' });
    }

    let parsedResult = task.result;
    try {
      if (task.result) {
        parsedResult = JSON.parse(task.result);
      }
    } catch (e) {
      // Keep original result if not valid JSON
    }

    res.json({
      ...task,
      result: parsedResult
    });

  } catch (error) {
    console.error('Error fetching task:', error);
    res.status(500).json({ error: 'Failed to fetch task', details: error.message });
  }
});

// Delete task endpoint
app.delete('/api/task/:id', authenticate, async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const email = req.user.email;

    const task = await prisma.task.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    if (task.email !== email) {
      return res.status(403).json({ error: 'Unauthorized to delete this task' });
    }

    await prisma.task.delete({
      where: { id: taskId },
    });

    res.status(200).json({ message: 'Task deleted successfully' });
  } catch (error) {
    console.error('Task Deletion Error:', error);
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.status(500).json({ error: 'Failed to delete task', details: error.message });
  }
});

// Update task status endpoint
app.patch('/api/task/:id/status', authenticate, async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const { status } = req.body;
    const email = req.user.email;

    if (!['pending', 'in-progress', 'completed', 'failed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }

    const task = await prisma.task.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    if (task.email !== email) {
      return res.status(403).json({ error: 'Unauthorized to update this task' });
    }

    const updatedTask = await prisma.task.update({
      where: { id: taskId },
      data: { status },
    });

    res.status(200).json({ message: 'Task status updated successfully', task: updatedTask });
  } catch (error) {
    console.error('Task Status Update Error:', error);
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.status(500).json({ error: 'Failed to update task status', details: error.message });
  }
});

// Retry task processing endpoint
app.post('/api/task/:id/retry', authenticate, async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const email = req.user.email;

    const task = await prisma.task.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    if (task.email !== email) {
      return res.status(403).json({ error: 'Unauthorized to retry this task' });
    }

    await prisma.task.update({
      where: { id: taskId },
      data: { 
        status: 'pending',
        result: null,
        type: 'retry'
      },
    });

    res.json({ message: 'Task retry initiated with Gemini AI' });

    // Process with Gemini again
    processTaskWithGemini(taskId, task.task, email);

  } catch (error) {
    console.error('Task retry error:', error);
    res.status(500).json({ error: 'Failed to retry task', details: error.message });
  }
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
  console.log('Environment variables check:');
  console.log('JWT_SECRET exists:', !!process.env.JWT_SECRET);
  console.log('GEMINI_API_KEY exists:', !!process.env.GEMINI_API_KEY);
  console.log('NODE_ENV:', process.env.NODE_ENV);
});