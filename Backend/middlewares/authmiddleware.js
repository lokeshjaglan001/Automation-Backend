import jwt from 'jsonwebtoken';

export default function authMiddleware(req, res, next) {
  const token = req.cookies?.token;
  console.log('Auth middleware: Token received:', token);
  if (!token) {
    return res.status(401).json({ message: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log('Auth-middleware: Decoded user:', decoded);
    req.user = decoded;
    next();
  } catch (err) {
    console.error('Auth-middleware: Token verification failed:', err.message);
    return res.status(401).json({ message: 'Invalid token' });
  }
}

export const authenticate = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    console.error('Authentication Error:', error);
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
};