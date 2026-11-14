package com.restaurantpos.app;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Sends a ticket (raw ESC/POS bytes, base64) straight to a network thermal printer on
 * host:port, usually 9100. The web app calls it as DirectPrint.print (lib/device-printer.ts).
 */
@CapacitorPlugin(name = "DirectPrint")
public class DirectPrintPlugin extends Plugin {

    private static final int CONNECT_TIMEOUT_MS = 4000;
    private static final int WRITE_TIMEOUT_MS = 8000;

    // One at a time, in order: two tickets sent together must not interleave on paper.
    private final ExecutorService printer = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void print(PluginCall call) {
        String host = call.getString("host", "").trim();
        int port = call.getInt("port", 9100);
        String data = call.getString("data", "");
        if (host.isEmpty()) {
            call.reject("No printer IP is set. Add it in Settings → Printing.");
            return;
        }
        final byte[] bytes;
        try {
            bytes = Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("The ticket couldn't be read.");
            return;
        }
        printer.execute(() -> {
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress(host, port), CONNECT_TIMEOUT_MS);
                socket.setSoTimeout(WRITE_TIMEOUT_MS);
                OutputStream out = socket.getOutputStream();
                out.write(bytes);
                out.flush();
                socket.shutdownOutput();
                JSObject result = new JSObject();
                result.put("bytes", bytes.length);
                call.resolve(result);
            } catch (java.net.SocketTimeoutException e) {
                call.reject("Printer " + host + " didn't answer. Is it on and on this WiFi?");
            } catch (java.net.UnknownHostException e) {
                call.reject("Printer address " + host + " isn't valid.");
            } catch (Exception e) {
                call.reject("Couldn't reach printer " + host + ": " + e.getMessage());
            }
        });
    }
}
