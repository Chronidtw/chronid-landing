const { createClient } = require('@supabase/supabase-js');

export default async function handler(req, res) {
  // Verify Cron Secret to ensure this is triggered by Vercel Cron
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Initialize Supabase Admin Client
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // List users (Supabase admin listUsers supports pagination, fetching first page for simplicity in this example)
    const { data: { users }, error } = await supabase.auth.admin.listUsers();
    
    if (error) {
      console.error('[Cron] Error fetching users:', error);
      return res.status(500).json({ error: 'Error fetching users from DB' });
    }

    const currentTime = new Date().getTime();
    let deletedCount = 0;

    for (const user of users) {
      const { endTime } = user.user_metadata || {};
      
      // If user has an endTime and it has passed
      if (endTime) {
        const endMs = new Date(endTime).getTime();
        
        if (currentTime > endMs) {
          console.log(`[Cron] Deleting expired user: ${user.email} (Expired at: ${endTime})`);
          
          const { error: deleteError } = await supabase.auth.admin.deleteUser(user.id);
          
          if (deleteError) {
            console.error(`[Cron] Error deleting user ${user.id}:`, deleteError);
          } else {
            deletedCount++;
          }
        }
      }
    }

    return res.status(200).json({ 
      success: true, 
      message: `Cron job executed successfully. Deleted ${deletedCount} expired accounts.` 
    });

  } catch (err) {
    console.error('[Cron Execution Error]', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
