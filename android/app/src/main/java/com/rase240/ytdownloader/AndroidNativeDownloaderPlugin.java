package com.rase240.ytdownloader;

import android.net.Uri;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AndroidNativeDownloader")
public class AndroidNativeDownloaderPlugin extends Plugin {

    @PluginMethod
    public void download(PluginCall call) {
        MainActivity activity = (MainActivity) getActivity();
        if (activity != null) {
            String url = call.getString("url");
            String filename = call.getString("filename");
            String mimeType = call.getString("mimeType");
            activity.performDownload(url, filename, mimeType);
            call.resolve();
        } else {
            call.reject("Activity not available");
        }
    }

    @PluginMethod
    public void openDownloadsFolder(PluginCall call) {
        MainActivity activity = (MainActivity) getActivity();
        if (activity != null) {
            activity.openDownloadsFolder();
            call.resolve();
        } else {
            call.reject("Activity not available");
        }
    }

    @PluginMethod
    public void openDownloadedFile(PluginCall call) {
        MainActivity activity = (MainActivity) getActivity();
        if (activity != null) {
            String filename = call.getString("filename");
            String mimeType = call.getString("mimeType");
            activity.openDownloadedFile(filename, mimeType);
            call.resolve();
        } else {
            call.reject("Activity not available");
        }
    }

    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        if (url == null) return null;
        String path = url.getPath();
        if (path == null) return null;

        // Never intercept API endpoints (POST /api/download, /api/info, etc.)
        if (path.startsWith("/api/download") || path.startsWith("/api/info") || path.startsWith("/api/auth")) {
            return null;
        }

        // Only intercept explicit static download files if navigated directly in WebView
        boolean isMediaFile = path.contains("/public_downloads/") ||
            path.startsWith("/api/file/") ||
            path.endsWith(".mp4") ||
            path.endsWith(".mp3") ||
            path.endsWith(".webm") ||
            path.endsWith(".m4a") ||
            path.endsWith(".mkv") ||
            path.endsWith(".opus");

        if (isMediaFile) {
            MainActivity activity = (MainActivity) getActivity();
            if (activity != null) {
                activity.performDownload(url.toString(), null, null);
                return Boolean.TRUE;
            }
        }
        return null;
    }
}
