package studio.mundo.player;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.CookieHandler;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Network operations run on the room worker. The game thread owns no URL connections. */
final class RoomTransport {
    private static final SecureRandom random = new SecureRandom();
    private static final String wire = "application/vnd.mundo.room-v3";
    private static final ScheduledThreadPoolExecutor deadlines = deadlines();

    private RoomTransport() {}

    // Called once, just after the native player library loads, from the application's class loader.
    static native void initialize();
    private static native boolean stopped(long transfer);
    private static native boolean acceptChunk(long transfer, byte[] bytes, int length);

    private static ScheduledThreadPoolExecutor deadlines() {
        ScheduledThreadPoolExecutor pool = new ScheduledThreadPoolExecutor(1, job -> {
            Thread thread = new Thread(job, "MUNDO room deadlines");
            thread.setDaemon(true);
            return thread;
        });
        pool.setRemoveOnCancelPolicy(true);
        return pool;
    }

    private static byte[] proof() {
        byte[] bytes = new byte[24];
        random.nextBytes(bytes);
        return bytes;
    }

    private static byte[] digest(ByteBuffer world) throws NoSuchAlgorithmException {
        MessageDigest sha = MessageDigest.getInstance("SHA-256");
        sha.update(world);
        return sha.digest();
    }

    private static long elapsedMs(long started) {
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
    }

    // Only the calling thread receives a native transfer handle. The timer owns only the connection.
    private static int post(String origin, String invite, String proof, String action, String json,
                            String scenePresence, int limit, long transfer) throws IOException {
        if (stopped(transfer) || CookieHandler.getDefault() != null) return 0;
        final boolean usage = action.equals("sector-usage") || action.equals("sector-usage-stages");
        final boolean statusOnly = action.equals("leave") || usage;
        final HttpURLConnection request = (HttpURLConnection)
                new URL(origin + "/room/" + action).openConnection(Proxy.NO_PROXY);
        final long budgetMs = statusOnly ? 1500 : 12000;
        final long started = System.nanoTime();
        final ScheduledFuture<?> timeout = deadlines.schedule(request::disconnect, budgetMs, TimeUnit.MILLISECONDS);
        try {
            request.setConnectTimeout(statusOnly ? 800 : 2500);
            request.setReadTimeout(statusOnly ? 900 : 3000);
            request.setUseCaches(false);
            request.setInstanceFollowRedirects(false);
            request.setRequestMethod("POST");
            request.setDoOutput(true);
            request.setRequestProperty("Content-Type", "application/json");
            boolean binaryPart = action.equals("entry-info") || action.equals("entry-part") ||
                    action.equals("world-part") || action.equals("world-rest") ||
                    action.equals("sector-plan") || action.equals("sector-part") ||
                    action.equals("sector-ahead") || action.equals("sector-ahead-part") ||
                    action.equals("sector-ready") || action.equals("sector-full") || usage ||
                    action.equals("cell-index") || action.equals("route");
            String accept = action.equals("meeting") ? "text/plain" : binaryPart ? "application/octet-stream" : wire;
            request.setRequestProperty("Accept", accept);
            request.setRequestProperty("X-Mundo-Travel", "1");
            request.setRequestProperty("X-Mundo-Circuit", "1");
            request.setRequestProperty("X-Mundo-Splits", "1");
            request.setRequestProperty("X-Mundo-Npcs", "1");
            request.setRequestProperty("X-Mundo-Race-Start", "1");
            request.setRequestProperty("Accept-Encoding", "identity");
            request.setRequestProperty("Origin", origin);
            request.setRequestProperty("X-Invite", invite);
            request.setRequestProperty("X-Seat", proof);
            if (scenePresence != null) request.setRequestProperty("X-Mundo-Scene", scenePresence);
            byte[] body = json.getBytes(StandardCharsets.UTF_8);
            // Streaming mode disallows automatic replay of POST on an authentication challenge.
            request.setFixedLengthStreamingMode(body.length);
            try (OutputStream stream = request.getOutputStream()) { stream.write(body); }
            if (stopped(transfer) || elapsedMs(started) >= budgetMs) return 0;
            int status = request.getResponseCode();
            if (status != 200 || statusOnly) return status;
            String type = request.getContentType();
            String expected = action.equals("world") ? "application/octet-stream" : accept;
            if (type == null || !type.split(";", 2)[0].trim().equalsIgnoreCase(expected)) return 0;
            String encoding = request.getContentEncoding();
            if (encoding != null && !encoding.equalsIgnoreCase("identity")) return 0;
            long declared = request.getContentLengthLong();
            if (declared > limit) return 0;
            int total = 0;
            byte[] buffer = new byte[Math.min(limit + 1, 32768)];
            try (InputStream stream = request.getInputStream()) {
                while (!stopped(transfer) && elapsedMs(started) < budgetMs) {
                    int count = stream.read(buffer);
                    if (count < 0) return declared < 0 || declared == total ? 200 : 0;
                    if (count == 0 || count > limit - total || !acceptChunk(transfer, buffer, count)) return 0;
                    total += count;
                }
            }
            return 0;
        } finally {
            timeout.cancel(false);
            request.disconnect();
        }
    }
}
