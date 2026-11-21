import React, { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet } from "react-native";
import { Logo } from "./ui";

let alreadyShown = false; // once per app launch (cold start), not when coming back from the background

/**
 * Short logo intro (about 1.3 s) drawn on top of the app while it starts underneath, so it never
 * slows down opening the app, offline or not. Skipped when the iPhone's Reduce Motion is on.
 * Touches pass through to the app.
 */
export function Intro() {
  const [visible, setVisible] = useState(!alreadyShown);
  const opacity = useRef(new Animated.Value(1)).current;
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.82)).current;

  useEffect(() => {
    if (!visible) return;
    alreadyShown = true;
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((reduce) => {
        if (cancelled) return;
        if (reduce) {
          setVisible(false);
          return;
        }
        Animated.sequence([
          Animated.parallel([
            Animated.timing(logoOpacity, { toValue: 1, duration: 450, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
            Animated.timing(scale, { toValue: 1, duration: 550, easing: Easing.out(Easing.back(1.6)), useNativeDriver: true }),
          ]),
          Animated.delay(350),
          Animated.timing(opacity, { toValue: 0, duration: 400, easing: Easing.in(Easing.quad), useNativeDriver: true }),
        ]).start(() => setVisible(false));
      });
    return () => {
      cancelled = true;
    };
  }, [visible, logoOpacity, opacity, scale]);

  if (!visible) return null;
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.wrap, { opacity }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View style={{ opacity: logoOpacity, transform: [{ scale }] }}>
        <Logo height={96} />
      </Animated.View>
    </Animated.View>
  );
}

// White to match the logo's own white background.
const styles = StyleSheet.create({ wrap: { backgroundColor: "#ffffff", alignItems: "center", justifyContent: "center", zIndex: 1000 } });
