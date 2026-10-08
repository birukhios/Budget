package et.birukfin.forwarder

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.*
import androidx.core.app.ActivityCompat
import kotlin.concurrent.thread

/**
 * Launcher activity. Once the server URL and token are set it steps aside and
 * opens the dashboard; the setup screen stays reachable from the long-press
 * shortcut on the app icon.
 */
class SetupActivity : Activity() {

    private lateinit var urlField: EditText
    private lateinit var tokenField: EditText
    private lateinit var status: TextView

    override fun onCreate(saved: Bundle?) {
        super.onCreate(saved)

        // Configured already, and not explicitly asked for settings → go to the app.
        if (Forwarder.config(this) != null && intent?.getBooleanExtra(EXTRA_SETTINGS, false) != true) {
            startActivity(Intent(this, TwaLauncher::class.java))
            finish()
            return
        }

        val p = Forwarder.prefs(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 72, 48, 48)
            setBackgroundColor(Color.parseColor("#0f1115"))
        }
        fun label(t: String) = TextView(this).apply {
            text = t; setTextColor(Color.parseColor("#949cad")); textSize = 12f
            setPadding(0, 28, 0, 6)
        }
        fun field(hint: String, value: String, pass: Boolean) = EditText(this).apply {
            this.hint = hint
            setText(value)
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#5a6072"))
            textSize = 15f
            inputType = if (pass) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                        else InputType.TYPE_TEXT_VARIATION_URI
        }

        root.addView(TextView(this).apply {
            text = "Birr — setup"; setTextColor(Color.WHITE); textSize = 22f
        })
        root.addView(TextView(this).apply {
            text = "Point the app at your own server. Only bank and wallet messages are read; nothing else leaves the phone."
            setTextColor(Color.parseColor("#949cad")); textSize = 13f
            setPadding(0, 10, 0, 0)
        })

        root.addView(label("Server URL"))
        urlField = field("https://your-server.example", p.getString(Forwarder.KEY_URL, "").orEmpty(), false)
        root.addView(urlField)

        root.addView(label("Ingest token"))
        tokenField = field("secret", p.getString(Forwarder.KEY_TOKEN, "").orEmpty(), true)
        root.addView(tokenField)

        root.addView(Button(this).apply {
            text = "Save & grant SMS permission"
            setOnClickListener { if (save()) requestPerm() }
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = 40 }
        })
        root.addView(Button(this).apply {
            text = "Test connection"
            setOnClickListener {
                if (!save()) return@setOnClickListener
                status.text = "Testing…"
                thread {
                    val r = Forwarder.testConnection(this@SetupActivity)
                    runOnUiThread { status.text = r }
                }
            }
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = 12 }
        })
        root.addView(Button(this).apply {
            text = "Import existing inbox"
            setOnClickListener { if (save()) runImport(false) }
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = 12 }
        })
        root.addView(Button(this).apply {
            text = "Import ALL messages (diagnostic)"
            setOnClickListener { if (save()) runImport(true) }
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = 12 }
        })
        root.addView(Button(this).apply {
            text = "Open dashboard"
            setOnClickListener {
                if (save()) { startActivity(Intent(this@SetupActivity, TwaLauncher::class.java)); finish() }
            }
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = 12 }
        })

        status = TextView(this).apply {
            setTextColor(Color.parseColor("#3ddc97")); textSize = 13f
            gravity = Gravity.START
            setPadding(0, 32, 0, 0)
        }
        root.addView(status)

        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun save(): Boolean {
        val url = urlField.text.toString().trim().trimEnd('/')
        val token = tokenField.text.toString().trim()
        if (url.isBlank() || token.isBlank()) { status.text = "Enter both the URL and the token."; return false }
        if (!url.startsWith("https://") && !url.contains("://10.") && !url.contains("://192.168.")) {
            status.text = "Use an https:// address — the token is sent in a header."
            return false
        }
        Forwarder.prefs(this).edit()
            .putString(Forwarder.KEY_URL, url)
            .putString(Forwarder.KEY_TOKEN, token)
            .apply()
        status.text = "Saved."
        return true
    }

    private fun requestPerm() {
        val need = arrayOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS)
            .filter { ActivityCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (need.isEmpty()) status.text = "Permission already granted. Forwarding is live."
        else ActivityCompat.requestPermissions(this, need.toTypedArray(), 1)
    }

    private fun runImport(everything: Boolean) {
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.READ_SMS)
            != PackageManager.PERMISSION_GRANTED) { requestPerm(); return }
        status.text = "Importing…"
        thread {
            val r = if (everything) Forwarder.importEverything(this)
                    else Forwarder.importInbox(this)
            runOnUiThread { status.text = r.toString() }
        }
    }

    override fun onRequestPermissionsResult(rc: Int, perms: Array<out String>, res: IntArray) {
        status.text = if (res.isNotEmpty() && res.all { it == PackageManager.PERMISSION_GRANTED })
            "Permission granted. Forwarding is live." else "Permission denied — forwarding is off."
    }

    companion object { const val EXTRA_SETTINGS = "settings" }
}
