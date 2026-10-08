package et.birukfin.forwarder

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import java.util.concurrent.Executors

/**
 * Catches incoming SMS, keeps only bank/wallet senders, and POSTs the raw
 * body to the server. Multipart messages are reassembled by sender.
 *
 * Failed sends are queued in SharedPreferences and retried on the next
 * message — no WorkManager dependency for something this small.
 */
class SmsReceiver : BroadcastReceiver() {

    private val pool = Executors.newSingleThreadExecutor()

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        if (parts.isEmpty()) return

        // Reassemble: concatenated SMS arrive as several PDUs from one sender.
        val sender = parts[0].displayOriginatingAddress ?: return
        if (!Forwarder.isFinancial(sender)) return
        val body = parts.joinToString("") { it.displayMessageBody ?: "" }
        val ts = parts[0].timestampMillis

        val pending = goAsync()
        pool.execute {
            try {
                val queue = loadQueue(context)
                queue.add(Triple(sender, body, ts))
                if (Forwarder.post(context, queue)) clearQueue(context) else saveQueue(context, queue)
            } finally {
                pending.finish()
            }
        }
    }

    // --- tiny retry queue (newline-delimited, capped) ---
    private fun loadQueue(ctx: Context): MutableList<Triple<String, String, Long>> {
        val raw = Forwarder.prefs(ctx).getString("queue", "").orEmpty()
        if (raw.isBlank()) return mutableListOf()
        return raw.split("\u001E").mapNotNull { rec ->
            val f = rec.split("\u001F")
            if (f.size == 3) Triple(f[0], f[1], f[2].toLongOrNull() ?: 0L) else null
        }.toMutableList()
    }

    private fun saveQueue(ctx: Context, q: List<Triple<String, String, Long>>) {
        val capped = q.takeLast(200)
        Forwarder.prefs(ctx).edit().putString(
            "queue", capped.joinToString("\u001E") { "${it.first}\u001F${it.second}\u001F${it.third}" }
        ).apply()
    }

    private fun clearQueue(ctx: Context) =
        Forwarder.prefs(ctx).edit().remove("queue").apply()
}
