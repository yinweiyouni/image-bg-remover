// Cloudflare Workers - Google OAuth 认证服务

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const GOOGLE_CLIENT_ID = "23518057491-97ufhj4s5lcra61o82b97vm61pr1hdot.apps.googleusercontent.com";
    const GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
    const REDIRECT_URI = "https://image-bg-remover-api.ab1710492709.workers.dev/api/auth/callback";
    const FRONTEND_URL = "https://image-bg-remover-xn3.pages.dev";
    const DAILY_LIMIT = 5;

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

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("Error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  }
};