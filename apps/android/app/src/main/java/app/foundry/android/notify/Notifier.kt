package app.foundry.android.notify

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import app.foundry.android.MainActivity
import app.foundry.android.R

/**
 * System notifications for `notify.push` WS events (P3) and ntfy pushes
 * (ADR-009). Requires android.permission.POST_NOTIFICATIONS (requested at
 * runtime on 33+); silently a no-op otherwise.
 */
object Notifier {
    private const val CHANNEL_ID = "foundry_push"
    private var nextId = 1

    fun ensureChannel(context: Context) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = android.app.NotificationChannel(
            CHANNEL_ID,
            "Foundry",
            NotificationManager.IMPORTANCE_DEFAULT,
        )
        manager.createNotificationChannel(channel)
    }

    fun post(context: Context, title: String, body: String, runId: String?) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (!manager.areNotificationsEnabled()) return

        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            if (runId != null) putExtra("runId", runId)
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pending = PendingIntent.getActivity(context, if (runId != null) runId.hashCode() else 0, intent, flags)

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(if (title.isNotBlank()) title else "Foundry")
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()
        manager.notify(nextId++, notification)
    }
}