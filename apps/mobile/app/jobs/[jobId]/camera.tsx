import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, Text, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { File } from "expo-file-system";
import * as Location from "expo-location";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Location as PhotoLocation, QueuedPhoto, Stage } from "@rsb/photo-sync";
import { useApp, useQueueVersion } from "../../../src/state";
import { LocalImage } from "../../../src/photos";
import { deleteQuietly } from "../../../src/platform";
import { Button, C, STAGES } from "../../../src/ui";

const THUMB_WIDTH = 360;

/**
 * Continuous camera tied to one job. Each tap of the shutter saves the photo straight into the
 * encrypted queue for this job; there is no "keep / retake" step. The latest photo's thumbnail
 * and flag button stay on screen. Tapping the thumbnail opens review; coming back resumes the camera.
 */
export default function Camera() {
  const app = useApp();
  useQueueVersion();
  const insets = useSafeAreaInsets();
  const { jobId, jobNumber } = useLocalSearchParams<{ jobId: string; jobNumber: string }>();
  const [permission, requestPermission] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [focused, setFocused] = useState(true);
  const [ready, setReady] = useState(false);
  const [stage, setStage] = useState<Stage>("during");
  const [latestId, setLatestId] = useState<string | null>(null);
  const [saving, setSaving] = useState(0);
  const [shooting, setShooting] = useState(false);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [gps, setGps] = useState<"off" | "waiting" | "on">("waiting");
  const lastFix = useRef<PhotoLocation | null>(null);

  // Only one camera preview may run at a time: pause it while the review screen is on top.
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  // Optional GPS: asked once; photos are still saved if the person says no.
  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    void (async () => {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) {
        setGps("off");
        return;
      }
      const last = await Location.getLastKnownPositionAsync({ maxAge: 120_000, requiredAccuracy: 200 });
      if (last) {
        lastFix.current = { latitude: last.coords.latitude, longitude: last.coords.longitude, accuracyM: last.coords.accuracy };
        setGps("on");
      }
      sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.Balanced, distanceInterval: 10 }, (loc) => {
        lastFix.current = { latitude: loc.coords.latitude, longitude: loc.coords.longitude, accuracyM: loc.coords.accuracy };
        setGps("on");
      });
    })().catch(() => setGps("off"));
    return () => sub?.remove();
  }, []);

  const latest: QueuedPhoto | undefined = latestId ? app.queue.get(latestId) : undefined;

  const shoot = async () => {
    if (!cam.current || !ready || shooting) return;
    setShooting(true);
    setError(null);
    let picUri: string | null = null;
    let thumbUri: string | null = null;
    try {
      const capturedAt = new Date().toISOString();
      const pic = await cam.current.takePictureAsync({ quality: 0.92, exif: false });
      picUri = pic.uri;
      setShooting(false); // ready for the next shot while this one is saved
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setSaving((n) => n + 1);
      const ctx = ImageManipulator.manipulate(pic.uri);
      ctx.resize({ width: THUMB_WIDTH, height: null });
      const thumb = await (await ctx.renderAsync()).saveAsync({ format: SaveFormat.JPEG, compress: 0.7 });
      thumbUri = thumb.uri;
      const [original, thumbnail] = await Promise.all([new File(pic.uri).bytes(), new File(thumb.uri).bytes()]);
      const rec = await app.queue.capture({
        orgId: app.session!.orgId,
        jobId,
        jobNumber,
        stage,
        capturedAt,
        original,
        thumbnail,
        widthPx: pic.width,
        heightPx: pic.height,
        location: lastFix.current,
      });
      setLatestId(rec.localId);
      setCount((n) => n + 1);
      app.syncNow();
    } catch (e) {
      setError(e instanceof Error ? `Photo not saved: ${e.message}` : "Photo not saved. Please try again.");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      // The camera's own files are unencrypted temporary copies: delete them right away.
      deleteQuietly(picUri);
      deleteQuietly(thumbUri);
      setShooting(false);
      if (picUri) setSaving((n) => n - 1);
    }
  };

  const toggleFlag = async () => {
    if (!latest) return;
    await app.queue.edit(latest.localId, { flagged: !latest.flagged });
    void Haptics.selectionAsync();
    app.syncNow();
  };

  if (!permission) {
    return (
      <View style={{ flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }
  if (!permission.granted) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg, padding: 24, justifyContent: "center", gap: 16 }}>
        <Text style={{ fontSize: 20, fontWeight: "700" }}>Camera access needed</Text>
        <Text style={{ color: C.muted }}>The app needs the camera to take job photos.</Text>
        {permission.canAskAgain ? (
          <Button title="Allow camera" onPress={() => void requestPermission()} />
        ) : (
          <Button title="Open Settings" onPress={() => void Linking.openSettings()} />
        )}
        <Button kind="secondary" title="Back" onPress={() => router.back()} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <CameraView ref={cam} style={{ flex: 1 }} facing="back" mode="picture" active={focused} onCameraReady={() => setReady(true)} onMountError={(e) => setError(e.message)} />

      {/* Top bar: job, stage, done */}
      <View style={{ position: "absolute", top: insets.top + 8, left: 12, right: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 }}>
            <Text style={{ color: "#fff", fontWeight: "800", fontSize: 16 }}>{jobNumber}</Text>
            <Text style={{ color: "#ddd", fontSize: 12 }}>
              {count} taken{saving ? " · saving…" : ""} · GPS {gps === "on" ? "on" : gps === "off" ? "off" : "…"}
            </Text>
          </View>
          <Pressable onPress={() => router.back()} hitSlop={12} style={{ backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10 }}>
            <Text style={{ color: "#fff", fontWeight: "700", fontSize: 16 }}>Done</Text>
          </Pressable>
        </View>
        <View style={{ flexDirection: "row", marginTop: 10, alignSelf: "center", backgroundColor: "rgba(0,0,0,0.55)", borderRadius: 20, padding: 4 }}>
          {STAGES.map((st) => (
            <Pressable
              key={st.value}
              onPress={() => setStage(st.value)}
              accessibilityState={{ selected: stage === st.value }}
              style={{ paddingHorizontal: 16, paddingVertical: 8, borderRadius: 16, backgroundColor: stage === st.value ? "#fff" : "transparent" }}
            >
              <Text style={{ fontWeight: "700", color: stage === st.value ? "#000" : "#fff" }}>{st.label}</Text>
            </Pressable>
          ))}
        </View>
        {error ? (
          <Text style={{ marginTop: 10, color: "#fff", backgroundColor: C.flag, padding: 8, borderRadius: 8, textAlign: "center" }}>{error}</Text>
        ) : null}
      </View>

      {/* Bottom bar: latest thumbnail, shutter, flag latest */}
      <View style={{ position: "absolute", bottom: insets.bottom + 20, left: 0, right: 0, flexDirection: "row", alignItems: "center", justifyContent: "space-around" }}>
        <Pressable
          disabled={!latest}
          onPress={() => latest && router.push({ pathname: "/photo/[key]", params: { key: `l:${latest.localId}`, jobId } })}
          accessibilityLabel="Review latest photo"
          style={{ width: 64, height: 64, borderRadius: 10, borderWidth: 2, borderColor: latest?.flagged ? C.flag : "#fff", overflow: "hidden", backgroundColor: "#222" }}
        >
          {latest ? <LocalImage key={latest.localId} localId={latest.localId} which="thumbnail" style={{ width: 60, height: 60 }} /> : null}
        </Pressable>

        <Pressable
          onPress={() => void shoot()}
          disabled={!ready || shooting}
          accessibilityLabel="Take photo"
          style={({ pressed }) => ({ width: 84, height: 84, borderRadius: 42, borderWidth: 5, borderColor: "#fff", alignItems: "center", justifyContent: "center", opacity: !ready ? 0.4 : 1 })}
        >
          {({ pressed }) => <View style={{ width: 66, height: 66, borderRadius: 33, backgroundColor: pressed || shooting ? "#ccc" : "#fff" }} />}
        </Pressable>

        <Pressable
          disabled={!latest}
          onPress={() => void toggleFlag()}
          accessibilityLabel={latest?.flagged ? "Unflag latest photo" : "Flag latest photo"}
          style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: latest?.flagged ? C.flag : "rgba(0,0,0,0.55)",
            borderWidth: 2,
            borderColor: latest?.flagged ? C.flag : "#fff",
            opacity: latest ? 1 : 0.35,
          }}
        >
          <Text style={{ color: "#fff", fontSize: 26, fontWeight: "900" }}>⚑</Text>
          <Text style={{ color: "#fff", fontSize: 10, fontWeight: "700" }}>{latest?.flagged ? "FLAGGED" : "FLAG"}</Text>
        </Pressable>
      </View>
    </View>
  );
}
