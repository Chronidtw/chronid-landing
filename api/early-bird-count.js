export const config = {
  api: {
    bodyParser: true,
  },
};

export default async function handler(req, res) {
  // 允許 GET 請求
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  // 設定 Cache-Control，避免前端過度頻繁請求
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;

    // 若未設定環境變數，回傳預設值 0 (確保前端不會掛掉)
    if (!kvUrl || !kvToken) {
      console.warn('Vercel KV environment variables missing. Returning 0.');
      return res.status(200).json({ count: 0 });
    }

    // 透過 Vercel KV REST API 取得目前的 count
    const response = await fetch(`${kvUrl}/get/early_bird_sold_count`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${kvToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch from KV: ${response.statusText}`);
    }

    const data = await response.json();
    
    // KV return format: { "result": "5" } (or null if not exists)
    const count = data.result ? parseInt(data.result, 10) : 0;

    return res.status(200).json({ count });

  } catch (error) {
    console.error('Error fetching early bird count:', error);
    // 出錯時回傳 0 以免阻擋正常購買流程
    return res.status(200).json({ count: 0 });
  }
}
