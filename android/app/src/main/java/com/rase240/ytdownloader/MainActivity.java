package com.rase240.ytdownloader;

import android.Manifest;
import android.app.DownloadManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.core.app.NotificationCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.BridgeActivity;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "MainActivityDownloader";
    private static final String CHANNEL_ID = "media_downloads_channel";
    private final ExecutorService directDownloadExecutor = Executors.newFixedThreadPool(2);
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final AtomicInteger notificationIdGenerator = new AtomicInteger(1000);

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AndroidNativeDownloaderPlugin.class);
        super.onCreate(savedInstanceState);

        createNotificationChannel();

        // Request notification permission on Android 13+ (API 33+) for download progress in drawer
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 101);
            }
        }

        // Attach native JavaScript interface to the WebView
        try {
            if (getBridge() != null && getBridge().getWebView() != null) {
                WebView webView = getBridge().getWebView();
                
                webView.addJavascriptInterface(new Object() {
                    @JavascriptInterface
                    public void downloadFile(String url, String filename, String mimeType) {
                        performDownload(url, filename, mimeType);
                    }

                    @JavascriptInterface
                    public void directDownload(String url, String filename, String mimeType) {
                        startDirectDownload(url, filename, mimeType);
                    }

                    @JavascriptInterface
                    public void openDownloadsFolder() {
                        MainActivity.this.openDownloadsFolder();
                    }

                    @JavascriptInterface
                    public void openDownloadedFile(String filename, String mimeType) {
                        MainActivity.this.openDownloadedFile(filename, mimeType);
                    }

                    @JavascriptInterface
                    public void showToast(String message) {
                        runOnUiThread(() -> Toast.makeText(getApplicationContext(), message, Toast.LENGTH_SHORT).show());
                    }

                    @JavascriptInterface
                    public void vibrate(long ms) {
                        MainActivity.this.vibrate(ms);
                    }

                    @JavascriptInterface
                    public boolean isNativeAndroid() {
                        return true;
                    }
                }, "AndroidDownloader");

                // DownloadListener safeguard
                webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
                    performDownload(url, URLUtil.guessFileName(url, contentDisposition, mimetype), mimetype);
                });
            }
        } catch (Exception e) {
            Log.e(TAG, "Error attaching JS interface", e);
        }

        // Handle hardware back button smoothly
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView != null) {
                    webView.evaluateJavascript(
                        "(function() { return (window.handleAndroidBackButton && window.handleAndroidBackButton()) ? 'handled' : 'not_handled'; })()",
                        value -> {
                            if (value == null || !value.contains("handled") || value.contains("not_handled")) {
                                finish();
                            }
                        }
                    );
                } else {
                    finish();
                }
            }
        });
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Media Downloads",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Shows media download progress and completion");
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) {
                nm.createNotificationChannel(channel);
            }
        }
    }

    /**
     * Sanitizes and guarantees a unique, non-colliding filename in the target directory.
     * Prevents Android Scoped Storage and Samsung DownloadManager crashes / paused states
     * caused by ERROR_FILE_ALREADY_EXISTS.
     */
    private String resolveSafeUniqueFilename(File dir, String rawFilename, String mimeType, String urlStr) {
        String clean = rawFilename;
        if (clean == null || clean.trim().isEmpty()) {
            clean = URLUtil.guessFileName(urlStr, null, mimeType);
        }
        if (clean == null || clean.trim().isEmpty() || clean.endsWith(".bin")) {
            clean = "YT_Download_" + System.currentTimeMillis() + ".mp4";
        }

        // Strip query parameters
        if (clean.contains("?")) {
            clean = clean.substring(0, clean.indexOf("?"));
        }

        // Replace illegal filesystem characters
        clean = clean.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        if (clean.isEmpty()) {
            clean = "YT_Download_" + System.currentTimeMillis() + ".mp4";
        }

        // Ensure proper extension
        if (!clean.contains(".")) {
            if (mimeType != null && mimeType.contains("audio")) {
                clean += ".mp3";
            } else {
                clean += ".mp4";
            }
        }

        if (!dir.exists()) {
            dir.mkdirs();
        }

        int dot = clean.lastIndexOf('.');
        String base = (dot > 0) ? clean.substring(0, dot) : clean;
        String ext = (dot > 0) ? clean.substring(dot) : "";

        File target = new File(dir, clean);
        int counter = 1;
        while (target.exists()) {
            clean = base + " (" + counter + ")" + ext;
            target = new File(dir, clean);
            counter++;
        }

        return clean;
    }

    /**
     * Enqueues download with system DownloadManager with all Samsung One UI and Android flags.
     * Starts a watchdog: if Samsung DownloadManager pauses on PAUSED_QUEUED_FOR_WIFI or stalls,
     * it automatically fails over to direct native in-app download immediately!
     */
    public void performDownload(String urlStr, String filename, String mimeType) {
        try {
            if (urlStr == null || urlStr.trim().isEmpty()) return;

            final File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            final String safeFilename = resolveSafeUniqueFilename(downloadsDir, filename, mimeType, urlStr);

            Uri uri = Uri.parse(urlStr);
            DownloadManager.Request request = new DownloadManager.Request(uri);

            // Set MIME type
            if (mimeType != null && !mimeType.isEmpty()) {
                request.setMimeType(mimeType);
            } else {
                String ext = MimeTypeMap.getFileExtensionFromUrl(safeFilename);
                if (ext != null && !ext.isEmpty()) {
                    String guessedMime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
                    if (guessedMime != null) request.setMimeType(guessedMime);
                }
            }

            // Pass cookies if present
            String cookies = CookieManager.getInstance().getCookie(urlStr);
            if (cookies != null && !cookies.isEmpty()) {
                request.addRequestHeader("cookie", cookies);
            }

            // Pass access token in header as well as query string
            try {
                String tokenParam = uri.getQueryParameter("token");
                if (tokenParam != null && !tokenParam.isEmpty()) {
                    request.addRequestHeader("x-access-token", tokenParam);
                }
            } catch (Exception ignored) {}

            request.addRequestHeader("User-Agent", "Mozilla/5.0 (Linux; Android 14; Mobile) YTDownloaderPro/1.0");
            request.addRequestHeader("Accept", "*/*");

            // CRITICAL FOR SAMSUNG ONE UI:
            // Allow download immediately over all networks, metered connections, and roaming without system delay
            request.setAllowedNetworkTypes(DownloadManager.Request.NETWORK_WIFI | DownloadManager.Request.NETWORK_MOBILE);
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(true);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                request.setRequiresCharging(false);
                request.setRequiresDeviceIdle(false);
            }

            request.setTitle(safeFilename);
            request.setDescription("Downloading media with YT Downloader Pro...");
            request.allowScanningByMediaScanner();
            request.setVisibleInDownloadsUi(true);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, safeFilename);

            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            if (dm != null) {
                final long downloadId = dm.enqueue(request);
                runOnUiThread(() -> Toast.makeText(
                    getApplicationContext(),
                    "Downloading " + safeFilename + " — check notification bar",
                    Toast.LENGTH_LONG
                ).show());

                // Watchdog: detect if Samsung One UI puts this download into PAUSED_QUEUED_FOR_WIFI
                // or if it hangs in STATUS_PAUSED. If so, failover immediately to Direct Download!
                mainHandler.postDelayed(() -> {
                    try {
                        DownloadManager.Query q = new DownloadManager.Query();
                        q.setFilterById(downloadId);
                        Cursor c = dm.query(q);
                        if (c != null && c.moveToFirst()) {
                            int statusIndex = c.getColumnIndex(DownloadManager.COLUMN_STATUS);
                            int reasonIndex = c.getColumnIndex(DownloadManager.COLUMN_REASON);
                            if (statusIndex >= 0) {
                                int status = c.getInt(statusIndex);
                                if (status == DownloadManager.STATUS_PAUSED) {
                                    int reason = reasonIndex >= 0 ? c.getInt(reasonIndex) : 0;
                                    Log.w(TAG, "DownloadManager PAUSED (reason=" + reason + "). Starting direct download fallback...");
                                    dm.remove(downloadId);
                                    runOnUiThread(() -> Toast.makeText(
                                        getApplicationContext(),
                                        "Device paused download (waiting for Wi-Fi). Starting direct download now...",
                                        Toast.LENGTH_LONG
                                    ).show());
                                    startDirectDownload(urlStr, safeFilename, mimeType);
                                } else if (status == DownloadManager.STATUS_FAILED) {
                                    int reason = reasonIndex >= 0 ? c.getInt(reasonIndex) : 0;
                                    Log.w(TAG, "DownloadManager FAILED (reason=" + reason + "). Starting direct download fallback...");
                                    dm.remove(downloadId);
                                    startDirectDownload(urlStr, safeFilename, mimeType);
                                }
                            }
                            c.close();
                        }
                    } catch (Exception watchErr) {
                        Log.w(TAG, "Watchdog error checking status", watchErr);
                    }
                }, 3000);
            } else {
                startDirectDownload(urlStr, safeFilename, mimeType);
            }
        } catch (Exception e) {
            Log.e(TAG, "DownloadManager error, switching to direct download", e);
            startDirectDownload(urlStr, filename, mimeType);
        }
    }

    /**
     * Direct In-App Native Downloader
     * Bypasses Samsung DownloadManager completely if system downloader is queued,
     * restricted to Wi-Fi, or unavailable. Directly streams the bytes to Downloads directory,
     * shows notification progress, and indexes into MediaStore.
     */
    public void startDirectDownload(String urlStr, String filename, String mimeType) {
        directDownloadExecutor.execute(() -> {
            HttpURLConnection conn = null;
            InputStream in = null;
            OutputStream out = null;
            final int notifId = notificationIdGenerator.incrementAndGet();
            final NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);

            try {
                final File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                final String safeFilename = resolveSafeUniqueFilename(downloadsDir, filename, mimeType, urlStr);
                final File targetFile = new File(downloadsDir, safeFilename);

                runOnUiThread(() -> Toast.makeText(
                    getApplicationContext(),
                    "Starting direct download: " + safeFilename,
                    Toast.LENGTH_SHORT
                ).show());

                NotificationCompat.Builder notifBuilder = new NotificationCompat.Builder(this, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.stat_sys_download)
                    .setContentTitle("Downloading " + safeFilename)
                    .setContentText("Connecting to server...")
                    .setPriority(NotificationCompat.PRIORITY_LOW)
                    .setOngoing(true)
                    .setProgress(100, 0, true);

                if (nm != null) {
                    nm.notify(notifId, notifBuilder.build());
                }

                URL url = new URL(urlStr);
                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(60000);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14; Mobile) YTDownloaderPro/1.0");
                conn.setRequestProperty("Accept", "*/*");

                Uri uri = Uri.parse(urlStr);
                String tokenParam = uri.getQueryParameter("token");
                if (tokenParam != null && !tokenParam.isEmpty()) {
                    conn.setRequestProperty("x-access-token", tokenParam);
                }

                conn.connect();
                int responseCode = conn.getResponseCode();
                if (responseCode < 200 || responseCode >= 300) {
                    throw new Exception("Server returned HTTP " + responseCode);
                }

                long fileLength = conn.getContentLengthLong();
                in = new BufferedInputStream(conn.getInputStream(), 64 * 1024);
                out = new FileOutputStream(targetFile);

                byte[] buffer = new byte[64 * 1024];
                long total = 0;
                int count;
                long lastNotifTime = 0;

                while ((count = in.read(buffer)) != -1) {
                    out.write(buffer, 0, count);
                    total += count;

                    long now = System.currentTimeMillis();
                    if (now - lastNotifTime > 800) {
                        lastNotifTime = now;
                        int progress = (fileLength > 0) ? (int) ((total * 100) / fileLength) : 0;
                        if (nm != null) {
                            notifBuilder.setProgress(100, progress, fileLength <= 0);
                            notifBuilder.setContentText(progress > 0 ? progress + "% downloaded" : "Downloading...");
                            nm.notify(notifId, notifBuilder.build());
                        }
                    }
                }
                out.flush();

                // Notify Android MediaStore so file immediately shows in Samsung Gallery & My Files
                MediaScannerConnection.scanFile(
                    getApplicationContext(),
                    new String[]{targetFile.getAbsolutePath()},
                    new String[]{mimeType != null ? mimeType : "*/*"},
                    null
                );

                // Build Open Intent for notification click
                Uri contentUri = FileProvider.getUriForFile(
                    getApplicationContext(),
                    getApplicationContext().getPackageName() + ".fileprovider",
                    targetFile
                );
                Intent openIntent = new Intent(Intent.ACTION_VIEW);
                openIntent.setDataAndType(contentUri, (mimeType != null && !mimeType.isEmpty()) ? mimeType : (safeFilename.endsWith(".mp3") ? "audio/*" : "video/*"));
                openIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                openIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

                PendingIntent pendingIntent = PendingIntent.getActivity(
                    this,
                    notifId,
                    openIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
                );

                NotificationCompat.Builder doneBuilder = new NotificationCompat.Builder(this, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.stat_sys_download_done)
                    .setContentTitle("Download Complete")
                    .setContentText(safeFilename)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setAutoCancel(true)
                    .setContentIntent(pendingIntent);

                if (nm != null) {
                    nm.cancel(notifId);
                    nm.notify(notifId + 10000, doneBuilder.build());
                }

                runOnUiThread(() -> Toast.makeText(
                    getApplicationContext(),
                    "Downloaded: " + safeFilename,
                    Toast.LENGTH_LONG
                ).show());

            } catch (Exception e) {
                Log.e(TAG, "Direct download failed", e);
                if (nm != null) {
                    nm.cancel(notifId);
                    NotificationCompat.Builder errorBuilder = new NotificationCompat.Builder(this, CHANNEL_ID)
                        .setSmallIcon(android.R.drawable.stat_notify_error)
                        .setContentTitle("Download Failed")
                        .setContentText(e.getMessage() != null ? e.getMessage() : "Network error")
                        .setPriority(NotificationCompat.PRIORITY_HIGH)
                        .setAutoCancel(true);
                    nm.notify(notifId + 20000, errorBuilder.build());
                }
                runOnUiThread(() -> Toast.makeText(
                    getApplicationContext(),
                    "Download error: " + e.getMessage(),
                    Toast.LENGTH_SHORT
                ).show());
            } finally {
                try { if (out != null) out.close(); } catch (Exception ignored) {}
                try { if (in != null) in.close(); } catch (Exception ignored) {}
                if (conn != null) conn.disconnect();
            }
        });
    }

    public void openDownloadedFile(String filename, String mimeType) {
        try {
            if (filename == null || filename.trim().isEmpty()) {
                openDownloadsFolder();
                return;
            }

            File file = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), filename);
            if (!file.exists()) {
                openDownloadsFolder();
                return;
            }

            Uri contentUri = FileProvider.getUriForFile(
                getApplicationContext(),
                getApplicationContext().getPackageName() + ".fileprovider",
                file
            );

            Intent intent = new Intent(Intent.ACTION_VIEW);
            if (mimeType == null || mimeType.isEmpty()) {
                String ext = MimeTypeMap.getFileExtensionFromUrl(file.getName());
                if (ext != null) {
                    mimeType = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
                }
            }
            if (mimeType == null || mimeType.isEmpty()) {
                mimeType = file.getName().endsWith(".mp3") ? "audio/*" : "video/*";
            }

            intent.setDataAndType(contentUri, mimeType);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

            Intent chooser = Intent.createChooser(intent, "Open with");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(chooser);
        } catch (Exception e) {
            openDownloadsFolder();
        }
    }

    public void openDownloadsFolder() {
        try {
            Intent intent = new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS);
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception e) {
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW);
                Uri uri = Uri.parse(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS).getPath());
                intent.setDataAndType(uri, "*/*");
                intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
            } catch (Exception ex) {
                runOnUiThread(() -> Toast.makeText(
                    getApplicationContext(),
                    "Check your Downloads folder for downloaded media",
                    Toast.LENGTH_SHORT
                ).show());
            }
        }
    }

    public void vibrate(long milliseconds) {
        try {
            Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            if (v != null && v.hasVibrator()) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    v.vibrate(VibrationEffect.createOneShot(Math.min(milliseconds, 150), VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    v.vibrate(Math.min(milliseconds, 150));
                }
            }
        } catch (Exception ignored) {}
    }
}
