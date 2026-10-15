package com.agentwatch.app

import android.util.Log
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

sealed interface PollResult {
    /** 200：拿到一份快照（长轮询挂到变化或超时才会走到这儿）。 */
    data class Ok(val snapshot: Snapshot) : PollResult

    /** 没凭据：401/403（admit 拒了），或者被 bridge 的补 token 重定向挡下（302）。 */
    data class NeedAuth(val code: Int) : PollResult

    /** 网络层就没通（Tailscale 断了、PC 关了、bridge 没起）。 */
    data class Failed(val why: String) : PollResult
}

/**
 * 待批端点的长轮询客户端。**本 App 唯一一处向外发请求**。
 *
 * ---------------------------------------------------------------------------
 * 🔴 认证：只用 cookie，**不碰 `?token=`**。这是**属主源码实证**，不是猜的：
 *
 *   `refs\dsh-client-connection\lib\index.js:388-427` 的 `authorizeIndex` ——
 *   `?token=` 只在 `req.method === "GET" && url.pathname === "/"` 上被认，且只用来
 *   **铸 cookie**（303 + `set-cookie`）。其它路径一律落到 `this.isAuthenticated(req)`
 *   （同文件 `:433-443`），而它**只看 cookie**。
 *   ⇒ 请求 `/agentwatch/pending?token=…` 必然是 401。没有第二条路。
 *
 *   ⇒ 凭据来源 = **WebView 那张 30 天的 `dsh-auth-*` cookie**（`CookieManager`），
 *     和 App 里那个 WebView 共用同一份。cookie 是 **authority 绑定**的
 *     （`:440` `payload.authority !== authority` 即废），我们和 WebView 打的是同一个
 *     authority，天然对得上。
 *
 * ---------------------------------------------------------------------------
 * ⚠️ 超时必须 > `wait`：服务端是**挂满 wait 秒才回**的（`?wait=0` 才是立刻要快照）。
 *    掐早了每轮都白等一次，而且会把一次正常的长轮询误判成「连接失败」。
 */
class PendingClient {

    /** 只为 `cancel()` —— 长轮询会占住一条 TCP，`Thread.interrupt()` 断不开 socket 读。 */
    @Volatile
    private var inflight: HttpURLConnection? = null

    fun cancel() {
        try {
            inflight?.disconnect()
        } catch (t: Throwable) {
            Log.w(TAG, "cancel 时断开连接失败：${t.message}")
        }
    }

    fun poll(url: String, waitSec: Int, cookie: String?): PollResult {
        val target = URL(if (waitSec > 0) "$url?wait=$waitSec" else "$url?wait=0")
        var conn: HttpURLConnection? = null
        try {
            conn = (target.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 10_000
                readTimeout = waitSec * 1000 + 20_000
                // 302 是 bridge 的「补 token」重定向，跟过去只会拿到一份 HTML index，
                // 对我们毫无意义 —— 让它原样回来，我们据此判定「凭据没生效」。
                instanceFollowRedirects = false
                setRequestProperty("Accept", "application/json")
                if (!cookie.isNullOrEmpty()) setRequestProperty("Cookie", cookie)
            }
            inflight = conn

            val code = conn.responseCode
            return when {
                code == 200 -> PollResult.Ok(parseSnapshot(readBody(conn)))
                // 401/403 = admit 拒了；302 = bridge 认为我们没带够凭据。两种都是「要重新登录」。
                code == 401 || code == 403 || code == 302 -> PollResult.NeedAuth(code)
                else -> PollResult.Failed("HTTP $code")
            }
        } catch (t: Throwable) {
            return PollResult.Failed(t.javaClass.simpleName + ": " + (t.message ?: ""))
        } finally {
            inflight = null
            try {
                conn?.disconnect()
            } catch (_: Throwable) {
            }
        }
    }

    /**
     * 整段读进来再一次性解码 —— 别按块 `String(...)`，那会在块边界上劈开多字节汉字。
     * 顺带上限：这是自己人的端点，但「自己人」不该成为不设防的理由。
     */
    private fun readBody(conn: HttpURLConnection): String {
        val ins = conn.inputStream ?: return ""
        return ins.use { s ->
            val bos = ByteArrayOutputStream()
            val buf = ByteArray(8192)
            var total = 0
            while (true) {
                val n = s.read(buf)
                if (n <= 0) break
                total += n
                if (total > MAX_BODY) break
                bos.write(buf, 0, n)
            }
            String(bos.toByteArray(), StandardCharsets.UTF_8)
        }
    }

    private companion object {
        const val TAG = "AgentWatch"
        const val MAX_BODY = 1 shl 20   // 1 MiB
    }
}
