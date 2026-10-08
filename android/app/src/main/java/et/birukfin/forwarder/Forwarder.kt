package et.birukfin.forwarder

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Everything network- and prefs-related. No third-party libraries:
 * HttpURLConnection and org.json are both in the Android platform.
 */
object Forwarder {

    private const val PREFS = "cfg"
    const val KEY_URL = "server_url"
    const val KEY_TOKEN = "token"
    const val KEY_LAST_IMPORT = "last_import"

    fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun config(ctx: Context): Pair<String, String>? {
        val p = prefs(ctx)
        val url = p.getString(KEY_URL, "").orEmpty()
        val token = p.getString(KEY_TOKEN, "").orEmpty()
        return if (url.isBlank() || token.isBlank()) null else url.trimEnd('/') to token
    }

    /** Senders we bother forwarding. Everything else never leaves the phone. */
    private val ALLOWED = listOf(
        "cbe", "telebirr", "m-pesa", "mpesa", "safaricom", "awash", "dashen", "amole",
        "boa", "abyssinia", "coopbank", "coop", "wegagen", "nib", "enat", "127"
    )

    fun isFinancial(sender: String?): Boolean {
        val s = sender?.lowercase() ?: return false
        return ALLOWED.any { s.contains(it) }
    }

    /** POST one or more messages. Blocking — call from a worker thread. */
    fun post(ctx: Context, messages: List<Triple<String, String, Long>>): Boolean {
        if (messages.isEmpty()) return true
        val (base, token) = config(ctx) ?: return false

        val arr = JSONArray()
        messages.forEach { (sender, body, ts) ->
            arr.put(JSONObject().apply {
                put("sender", sender)
                put("body", body)
                put("received_at", java.text.SimpleDateFormat(
                    "yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US
                ).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.format(java.util.Date(ts)))
            })
        }
        val payload = JSONObject().put("messages", arr).toString().toByteArray()

        return try {
            (URL("$base/api/ingest").openConnection() as HttpURLConnection).run {
                requestMethod = "POST"
                connectTimeout = 15000
                readTimeout = 15000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Authorization", "Bearer $token")
                outputStream.use { it.write(payload) }
                val ok = responseCode in 200..299
                disconnect()
                ok
            }
        } catch (e: Exception) {
            false
        }
    }

    /** Result of an inbox scan, so the UI can say where messages were lost. */
    data class ImportResult(
        val scanned: Int, val matched: Int, val sent: Int,
        val senders: List<String>, val error: String? = null,
    ) {
        override fun toString(): String = when {
            error != null -> "Error: $error"
            scanned == 0 -> "No SMS found on this phone."
            matched == 0 -> "Scanned $scanned messages, none from a known bank.\n" +
                "Senders seen: ${senders.take(12).joinToString(", ")}"
            sent == 0 -> "Matched $matched messages but the server did not accept them.\n" +
                "Check the URL and token."
            else -> "Sent $sent of $matched matched (scanned $scanned)."
        }
    }

    /** Can we reach the server with these credentials? */
    fun testConnection(ctx: Context): String {
        val (base, token) = config(ctx) ?: return "Enter the URL and token first."
        return try {
            (URL("$base/api/ingest").openConnection() as HttpURLConnection).run {
                requestMethod = "POST"
                connectTimeout = 10000
                readTimeout = 10000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Authorization", "Bearer $token")
                outputStream.use { it.write("""{"messages":[]}""".toByteArray()) }
                val code = responseCode
                disconnect()
                when (code) {
                    in 200..299 -> "Connected. Server accepted the token."
                    401 -> "Reached the server, but the token is wrong."
                    else -> "Reached the server, got HTTP $code."
                }
            }
        } catch (e: Exception) {
            "Cannot reach $base — ${e.javaClass.simpleName}. " +
                "Same Wi-Fi? Firewall off on the computer?"
        }
    }

    /**
     * One-time backfill of the existing inbox, so the dashboard isn't empty
     * on day one. Reads only messages from allowed senders.
     */
    fun importInbox(ctx: Context, sinceMillis: Long = 0L): ImportResult {
        val cols = arrayOf("address", "body", "date")
        val cursor = try {
            ctx.contentResolver.query(
                Uri.parse("content://sms/inbox"), cols,
                "date > ?", arrayOf(sinceMillis.toString()), "date ASC"
            )
        } catch (e: SecurityException) {
            return ImportResult(0, 0, 0, emptyList(), "SMS permission not granted")
        } ?: return ImportResult(0, 0, 0, emptyList(), "Cannot read the SMS inbox")

        val batch = mutableListOf<Triple<String, String, Long>>()
        val seen = linkedSetOf<String>()   // distinct senders, for the report
        var scanned = 0; var matched = 0; var sent = 0

        cursor.use { c ->
            val iA = c.getColumnIndexOrThrow("address")
            val iB = c.getColumnIndexOrThrow("body")
            val iD = c.getColumnIndexOrThrow("date")
            while (c.moveToNext()) {
                scanned++
                val sender = c.getString(iA) ?: continue
                seen.add(sender)
                if (!isFinancial(sender)) continue
                matched++
                batch.add(Triple(sender, c.getString(iB) ?: "", c.getLong(iD)))
                if (batch.size >= 100) {           // keep payloads small
                    if (post(ctx, batch)) sent += batch.size
                    batch.clear()
                }
            }
        }
        if (batch.isNotEmpty() && post(ctx, batch)) sent += batch.size
        prefs(ctx).edit().putLong(KEY_LAST_IMPORT, System.currentTimeMillis()).apply()
        return ImportResult(scanned, matched, sent, seen.toList())
    }

    /**
     * Escape hatch: forward EVERY message from every sender, letting the
     * server decide. Used when the allowlist misses a bank's sender id —
     * the server rejects non-financial messages anyway.
     */
    fun importEverything(ctx: Context): ImportResult {
        val cursor = try {
            ctx.contentResolver.query(
                Uri.parse("content://sms/inbox"),
                arrayOf("address", "body", "date"), null, null, "date DESC"
            )
        } catch (e: SecurityException) {
            return ImportResult(0, 0, 0, emptyList(), "SMS permission not granted")
        } ?: return ImportResult(0, 0, 0, emptyList(), "Cannot read the SMS inbox")

        val batch = mutableListOf<Triple<String, String, Long>>()
        val seen = linkedSetOf<String>()
        var scanned = 0; var sent = 0
        cursor.use { c ->
            val iA = c.getColumnIndexOrThrow("address")
            val iB = c.getColumnIndexOrThrow("body")
            val iD = c.getColumnIndexOrThrow("date")
            while (c.moveToNext() && scanned < 2000) {
                scanned++
                val sender = c.getString(iA) ?: "unknown"
                seen.add(sender)
                batch.add(Triple(sender, c.getString(iB) ?: "", c.getLong(iD)))
                if (batch.size >= 100) {
                    if (post(ctx, batch)) sent += batch.size
                    batch.clear()
                }
            }
        }
        if (batch.isNotEmpty() && post(ctx, batch)) sent += batch.size
        return ImportResult(scanned, scanned, sent, seen.toList())
    }
}
