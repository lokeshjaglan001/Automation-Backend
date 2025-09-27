import express from 'express';
import { PrismaClient } from '@prisma/client';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import authMiddleware from './middlewares/authmiddleware.js';

const app = express();
const prisma = new PrismaClient();

app.use(express.json());
app.use(
  cors({
    origin: 'http://localhost:5173',
    credentials: true,
  })
);
app.use(cookieParser());

// Middleware for authentication
const authenticate = authMiddleware; // Ensure this is the same as imported

// Home endpoint (protected)
app.get('/api/home', authenticate, (req, res) => {
  console.log('Serving /api/home for user:', req.user); // Debug
  res.json({
    message: 'Protected home data',
    user: req.user, // { id, email } from JWT
  });
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
    console.error('Database error:', error);
    res.status(500).json({ error: 'Something went wrong' });
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
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
  console.log('Logout route hit'); // Debug
  res.cookie('token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
  });
  res.status(200).json({ message: 'Logged out successfully' });
});

// Delete account endpoint
app.delete('/api/delete', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
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
    res.status(500).json({ error: 'Something went wrong' });
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
    console.error('Database error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Create task endpoint
app.post('/api/task', authenticate, async (req, res) => {
  try {
    const { content } = req.body;
    const email = req.user.email;
    console.log('req.user:', req.user);
    if (!email) {
      return res.status(401).json({ error: 'Unauthorized: User not authenticated' });
    }
    if (!content || content.trim() === '') {
      return res.status(400).json({ error: 'Task content is required' });
    }
    if (content.trim().length < 3) {
      return res.status(400).json({ error: 'Task content must be at least 3 characters long' });
    }
    const newTask = await prisma.Task.create({
      data: {
        email,
        task: content.trim(),
      },
    });
    console.log('Created Task:', newTask);
    res.status(201).json({ message: 'Task created successfully', task: newTask });
  } catch (error) {
    console.error('Task Creation Error:', error);
    res.status(500).json({ error: 'Failed to create task: ' + error.message });
  }
});

// Get tasks endpoint
app.get('/api/tasks', authenticate, async (req, res) => {
  try {
    const email = req.user.email;
    const tasks = await prisma.Task.findMany({
      where: { email },
      orderBy: { createdAt: 'desc' },
    });
    res.status(200).json({ tasks }); // Return { tasks: [...] } to match frontend
  } catch (error) {
    console.error('Tasks Fetch Error:', error);
    res.status(500).json({ error: 'Failed to fetch tasks: ' + error.message });
  }
});

// Delete task endpoint
app.delete('/api/task/:id', authenticate, async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const email = req.user.email;

    // Find the task to verify ownership
    const task = await prisma.Task.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    if (task.email !== email) {
      return res.status(403).json({ error: 'Unauthorized to delete this task' });
    }

    await prisma.Task.delete({
      where: { id: taskId },
    });

    res.status(200).json({ message: 'Task deleted successfully' });
  } catch (error) {
    console.error('Task Deletion Error:', error);
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.status(500).json({ error: 'Failed to delete task: ' + error.message });
  }
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
});