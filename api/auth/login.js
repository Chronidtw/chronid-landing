const { createClient } = require('@supabase/supabase-js');

export default async function handler(req, res) {
  // Only allow POST requests for login
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    // Initialize Supabase Client
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY // Use service role for admin validation if needed, or anon key if preferred
    );

    // Authenticate User
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = data.user;
    const { startTime, endTime } = user.user_metadata || {};

    if (!startTime || !endTime) {
      // If no rental times are set, assume it's a regular user or admin, allow login
      return res.status(200).json({ success: true, session: data.session, user });
    }

    // Time Validation Guard
    const currentTime = new Date().getTime();
    const startMs = new Date(startTime).getTime();
    const endMs = new Date(endTime).getTime();

    if (currentTime < startMs) {
      return res.status(403).json({
        error: `Your booking session has not started yet. Valid from: ${startTime}`
      });
    }

    if (currentTime > endMs) {
      return res.status(403).json({
        error: 'Your booking session has expired.'
      });
    }

    // Valid time window
    return res.status(200).json({
      success: true,
      message: 'Login successful',
      session: data.session,
      user
    });

  } catch (err) {
    console.error('[Login Auth Error]', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
