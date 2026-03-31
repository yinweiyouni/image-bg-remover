// Cloudflare Workers - Google OAuth + PayPal 支付服务

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const GOOGLE_CLIENT_ID = "23518057491-97ufhj4s5lcra61o82b97vm61pr1hdot.apps.googleusercontent.com";
    const GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
    const PAYPAL_CLIENT_ID = env.PAYPAL_CLIENT_ID;
    const PAYPAL_CLIENT_SECRET = env.PAYPAL_CLIENT_SECRET;
    const PAYPAL_MODE = env.PAYPAL_MODE || "sandbox"; // sandbox 或 live
    const REDIRECT_URI = "https://api.image-bg-remover-xn3.pages.dev/api/auth/callback";
    const FRONTEND_URL = "https://image-bg-remover-xn3.pages.dev";
    const DAILY_LIMIT = 5;

    // PayPal API 基础 URL
    const PAYPAL_API_BASE = PAYPAL_MODE === "sandbox"
      ? "https://api.sandbox.paypal.com"
      : "https://api.paypal.com";

    // 生成随机字符串
    function generateRandomString(length: number): string {
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      let result = "";
      for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return result;
    }

    // 获取今天的日期字符串 (YYYY-MM-DD)
    function getTodayDate(): string {
      const now = new Date();
      return now.toISOString().split("T")[0];
    }

    // 生成会话 token
    function generateSessionToken(): string {
      return generateRandomString(64);
    }

    try {
      // 登录入口
      if (path === "/api/auth/login") {
        const state = generateRandomString(32);
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=openid%20email%20profile&state=${state}&prompt=consent`;
        const response = Response.redirect(authUrl);
        response.headers.set("Set-Cookie", `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
        return response;
      }

      // OAuth 回调
      if (path === "/api/auth/callback") {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          return Response.redirect(`${FRONTEND_URL}?error=${error}`);
        }

        if (!code) {
          return Response.redirect(`${FRONTEND_URL}?error=no_code`);
        }

        // 兑换授权码
        const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            code: code,
            grant_type: "authorization_code",
            redirect_uri: REDIRECT_URI,
          }),
        });

        if (!tokenResponse.ok) {
          console.error("Token exchange failed:", await tokenResponse.text());
          return Response.redirect(`${FRONTEND_URL}?error=token_exchange_failed`);
        }

        const tokenData = await tokenResponse.json() as any;
        const accessToken = tokenData.access_token;

        // 获取用户信息
        const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!userInfoResponse.ok) {
          return Response.redirect(`${FRONTEND_URL}?error=user_info_failed`);
        }

        const userInfo = await userInfoResponse.json() as any;
        const userId = "google_" + userInfo.id;
        const userEmail = userInfo.email;
        const userName = userInfo.name || "";
        const userAvatar = userInfo.picture || "";

        // 查询用户是否已存在
        const existingUser = await env.user_db.prepare(
          "SELECT id FROM users WHERE id = ?"
        ).bind(userId).first();

        if (!existingUser) {
          // 新用户，创建用户记录
          await env.user_db.prepare(
            "INSERT INTO users (id, email, name, avatar, created_at) VALUES (?, ?, ?, ?, ?)"
          ).bind(userId, userEmail, userName, userAvatar, Date.now()).run();
        }

        // 生成会话 token 并存储到数据库
        const sessionToken = generateSessionToken();
        const tokenExpiry = Date.now() + (30 * 24 * 60 * 60 * 1000); // 30天有效期

        await env.user_db.prepare(
          "INSERT OR REPLACE INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)"
        ).bind(sessionToken, userId, tokenExpiry).run();

        // 设置 cookie
        const userData = JSON.stringify({ id: userId, email: userEmail, name: userName, avatar: userAvatar });
        const userDataEncoded = btoa(unescape(encodeURIComponent(userData)));

        const response = Response.redirect(`${FRONTEND_URL}`);
        response.headers.set("Set-Cookie", `token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; user=${userDataEncoded}`);
        return response;
      }

      // 获取用户信息
      if (path === "/api/user/info") {
        const cookie = request.headers.get("Cookie") || "";
        const userMatch = cookie.match(/user=([^;]+)/);

        if (!userMatch) {
          return new Response(JSON.stringify({ loggedIn: false }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        try {
          const userData = JSON.parse(decodeURIComponent(escape(atob(userMatch[1]))));
          return new Response(JSON.stringify({
            loggedIn: true,
            user: userData,
          }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch {
          return new Response(JSON.stringify({ loggedIn: false }), {
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      // 获取剩余次数
      if (path === "/api/usage") {
        const cookie = request.headers.get("Cookie") || "";
        const userMatch = cookie.match(/user=([^;]+)/);

        if (!userMatch) {
          return new Response(JSON.stringify({ loggedIn: false, remaining: 0 }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        try {
          const userData = JSON.parse(decodeURIComponent(escape(atob(userMatch[1]))));
          const userId = userData.id;
          const today = getTodayDate();

          // 查询今日使用次数
          const usageRecord = await env.user_db.prepare(
            "SELECT count FROM user_usage WHERE user_id = ? AND date = ?"
          ).bind(userId, today).first();

          const usedCount = usageRecord ? usageRecord.count : 0;

          return new Response(JSON.stringify({
            loggedIn: true,
            remaining: DAILY_LIMIT - usedCount,
            used: usedCount,
            limit: DAILY_LIMIT,
            date: today,
          }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (error) {
          console.error("获取使用次数失败:", error);
          return new Response(JSON.stringify({ loggedIn: true, remaining: DAILY_LIMIT }), {
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      // 使用一次 API（扣除次数）
      if (path === "/api/usage/use" && request.method === "POST") {
        const cookie = request.headers.get("Cookie") || "";
        const userMatch = cookie.match(/user=([^;]+)/);

        if (!userMatch) {
          return new Response(JSON.stringify({ success: false, error: "not_logged_in" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        try {
          const userData = JSON.parse(decodeURIComponent(escape(atob(userMatch[1]))));
          const userId = userData.id;
          const today = getTodayDate();

          // 事务性更新：检查并增加使用次数
          const result = await env.user_db.prepare(
            `INSERT INTO user_usage (user_id, date, count) VALUES (?, ?, 1)
             ON CONFLICT(user_id, date) DO UPDATE SET count = count + 1`
          ).bind(userId, today).run();

          // 检查是否超限
          const usageRecord = await env.user_db.prepare(
            "SELECT count FROM user_usage WHERE user_id = ? AND date = ?"
          ).bind(userId, today).first();

          if (usageRecord && usageRecord.count > DAILY_LIMIT) {
            // 超过限制，回滚
            await env.user_db.prepare(
              "UPDATE user_usage SET count = count - 1 WHERE user_id = ? AND date = ?"
            ).bind(userId, today).run();

            return new Response(JSON.stringify({ success: false, error: "daily_limit_exceeded" }), {
              status: 403,
              headers: { "Content-Type": "application/json" },
            });
          }

          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (error) {
          console.error("使用 API 失败:", error);
          return new Response(JSON.stringify({ success: false, error: "server_error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      // 退出登录
      if (path === "/api/auth/logout") {
        const cookie = request.headers.get("Cookie") || "";
        const tokenMatch = cookie.match(/token=([^;]+)/);

        if (tokenMatch) {
          const token = tokenMatch[1];
          await env.user_db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
        }

        const response = new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
        response.headers.set("Set-Cookie", "token=; Path=/; HttpOnly; Max-Age=0; user=; Path=/; Max-Age=0");
        return response;
      }

      // 检查登录状态
      if (path === "/api/auth/status") {
        const cookie = request.headers.get("Cookie") || "";
        const tokenMatch = cookie.match(/token=([^;]+)/);
        const userMatch = cookie.match(/user=([^;]+)/);

        if (tokenMatch && userMatch) {
          const token = tokenMatch[1];
          // 验证 token 是否有效
          const session = await env.user_db.prepare(
            "SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?"
          ).bind(token, Date.now()).first();

          if (session) {
            try {
              const userData = JSON.parse(decodeURIComponent(escape(atob(userMatch[1]))));
              return new Response(JSON.stringify({
                loggedIn: true,
                user: userData,
              }), {
                headers: { "Content-Type": "application/json" },
              });
            } catch {
              return new Response(JSON.stringify({ loggedIn: false }), {
                headers: { "Content-Type": "application/json" },
              });
            }
          }
        }

        return new Response(JSON.stringify({ loggedIn: false }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // ========== PayPal 测试端点 ==========

      // 获取 PayPal Access Token（测试用）
      if (path === "/api/paypal/test-token") {
        if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
          return new Response(JSON.stringify({ error: "PayPal credentials not configured" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        const auth = btoa(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`);
        const tokenResponse = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
          method: "POST",
          headers: {
            "Authorization": `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: "grant_type=client_credentials",
        });

        if (!tokenResponse.ok) {
          const errorText = await tokenResponse.text();
          console.error("PayPal token failed:", errorText);
          return new Response(JSON.stringify({
            error: "Failed to get access token",
            details: errorText,
          }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        const tokenData = await tokenResponse.json() as any;
        return new Response(JSON.stringify({
          success: true,
          mode: PAYPAL_MODE,
          access_token: tokenData.access_token,
          token_type: tokenData.token_type,
          expires_in: tokenData.expires_in,
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // 创建 PayPal 订单（测试用）
      if (path === "/api/paypal/create-test-order" && request.method === "POST") {
        const cookie = request.headers.get("Cookie") || "";
        const userMatch = cookie.match(/user=([^;]+)/);

        if (!userMatch) {
          return new Response(JSON.stringify({ success: false, error: "not_logged_in" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        const userData = JSON.parse(decodeURIComponent(escape(atob(userMatch[1]))));
        const userId = userData.id;

        // 测试用套餐：$1 = 10 credits
        const orderData = {
          intent: "CAPTURE",
          purchase_units: [{
            reference_id: `user_${userId}`,
            description: "10 Image Background Removal Credits",
            amount: {
              currency_code: "USD",
              value: "1.00",
            },
          }],
          application_context: {
            brand_name: "Image BG Remover",
            landing_page: "NO_PREFERENCE",
            user_action: "PAY_NOW",
            return_url: FRONTEND_URL,
            cancel_url: FRONTEND_URL,
          },
        };

        // 获取 Access Token
        const auth = btoa(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`);
        const tokenResponse = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
          method: "POST",
          headers: {
            "Authorization": `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: "grant_type=client_credentials",
        });

        if (!tokenResponse.ok) {
          return new Response(JSON.stringify({ success: false, error: "Failed to get PayPal token" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        const tokenResult = await tokenResponse.json() as any;
        const accessToken = tokenResult.access_token;

        // 创建订单
        const orderResponse = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(orderData),
        });

        if (!orderResponse.ok) {
          const errorText = await orderResponse.text();
          console.error("PayPal order failed:", errorText);
          return new Response(JSON.stringify({
            success: false,
            error: "Failed to create order",
            details: errorText,
          }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        const orderResult = await orderResponse.json() as any;

        // 保存订单到数据库
        const orderId = orderResult.id;
        const tokenExpiry = Date.now() + (30 * 60 * 1000); // 30分钟有效

        await env.user_db.prepare(
          `INSERT INTO paypal_orders (order_id, user_id, amount, credits, status, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(orderId, userId, "1.00", 10, "created", Date.now(), tokenExpiry).run();

        return new Response(JSON.stringify({
          success: true,
          orderId: orderId,
          status: orderResult.status,
          approve_url: orderResult.links?.find((l: any) => l.rel === "approve")?.href,
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // 确认/捕获 PayPal 订单
      if (path === "/api/paypal/capture-test-order" && request.method === "POST") {
        const body: any = await request.json();
        const orderId = body.order_id;

        if (!orderId) {
          return new Response(JSON.stringify({ success: false, error: "order_id required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        // 获取 Access Token
        const auth = btoa(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`);
        const tokenResponse = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
          method: "POST",
          headers: {
            "Authorization": `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: "grant_type=client_credentials",
        });

        if (!tokenResponse.ok) {
          return new Response(JSON.stringify({ success: false, error: "Failed to get PayPal token" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        const tokenResult = await tokenResponse.json() as any;
        const accessToken = tokenResult.access_token;

        // 捕获订单
        const captureResponse = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        });

        if (!captureResponse.ok) {
          const errorText = await captureResponse.text();
          return new Response(JSON.stringify({
            success: false,
            error: "Failed to capture order",
            details: errorText,
          }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        const captureResult = await captureResponse.json() as any;

        // 更新订单状态
        await env.user_db.prepare(
          "UPDATE paypal_orders SET status = ?, updated_at = ? WHERE order_id = ?"
        ).bind(captureResult.status, Date.now(), orderId).run();

        // 如果支付成功，添加积分到用户账户
        if (captureResult.status === "COMPLETED") {
          const orderRecord = await env.user_db.prepare(
            "SELECT user_id, credits FROM paypal_orders WHERE order_id = ?"
          ).bind(orderId).first();

          if (orderRecord) {
            // 添加积分到用户账户
            const existingCredits = await env.user_db.prepare(
              "SELECT credits FROM user_credits WHERE user_id = ?"
            ).bind(orderRecord.user_id).first();

            if (existingCredits) {
              await env.user_db.prepare(
                "UPDATE user_credits SET credits = credits + ?, updated_at = ? WHERE user_id = ?"
              ).bind(orderRecord.credits, Date.now(), orderRecord.user_id).run();
            } else {
              await env.user_db.prepare(
                "INSERT INTO user_credits (user_id, credits, updated_at) VALUES (?, ?, ?)"
              ).bind(orderRecord.user_id, orderRecord.credits, Date.now()).run();
            }
          }
        }

        return new Response(JSON.stringify({
          success: true,
          orderId: orderId,
          status: captureResult.status,
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // PayPal Webhook（用于测试）
      if (path === "/api/paypal/webhook" && request.method === "POST") {
        const bodyText = await request.text();
        const body = JSON.parse(bodyText);

        console.log("PayPal Webhook received:", body.event_type);
        console.log("Webhook body:", bodyText);

        // 记录 webhook 到日志
        await env.user_db.prepare(
          `INSERT INTO paypal_webhooks (event_type, order_id, status, raw_data, received_at)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(
          body.event_type,
          body.resource?.id || body.resource?.purchase_units?.[0]?.reference_id,
          body.resource?.status || "unknown",
          bodyText,
          Date.now()
        ).run();

        // 处理不同的 webhook 事件
        if (body.event_type === "CHECKOUT.ORDER.APPROVED") {
          console.log("Order approved:", body.resource?.id);
        } else if (body.event_type === "PAYMENT.CAPTURE.COMPLETED") {
          console.log("Payment completed:", body.resource?.id);
          // 这里可以更新订单状态和添加积分
        }

        return new Response(JSON.stringify({ received: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("Error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  }
};