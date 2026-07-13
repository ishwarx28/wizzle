import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { frontendLogger } from "./logger";

type DesktopNotificationOptions = {
  body: string;
  tag?: string;
  title: string;
};

let didRequestNotificationPermission = false;

async function isAppBackgrounded() {
  const domBackgrounded =
    typeof document !== "undefined" && (document.hidden || !document.hasFocus());

  try {
    const appWindow = getCurrentWindow();
    const [isFocused, isMinimized, isVisible] = await Promise.all([
      appWindow.isFocused(),
      appWindow.isMinimized(),
      appWindow.isVisible(),
    ]);
    return domBackgrounded || !isFocused || isMinimized || !isVisible;
  } catch {
    return domBackgrounded;
  }
}

function hasNotificationApi() {
  return typeof window !== "undefined" && "Notification" in window;
}

function notificationIdForTag(tag: string) {
  let hash = 0;
  for (let index = 0; index < tag.length; index += 1) {
    hash = (Math.imul(hash, 31) + tag.charCodeAt(index)) | 0;
  }
  return ((hash >>> 0) % 2_147_483_647) || 1;
}

export function requestNotificationPermissionForUserGesture() {
  if (!hasNotificationApi()) {
    return Promise.resolve(false);
  }

  if (Notification.permission === "granted") {
    return Promise.resolve(true);
  }

  if (Notification.permission === "denied" || didRequestNotificationPermission) {
    return Promise.resolve(false);
  }

  didRequestNotificationPermission = true;

  try {
    return requestPermission().then((permission) => permission === "granted");
  } catch (error) {
    frontendLogger.debug("frontend.notification", "notification_permission_request_failed", {
      error,
    });
    return Promise.resolve(false);
  }
}

export async function notifyWhenAppBackgrounded(options: DesktopNotificationOptions) {
  if (!hasNotificationApi() || !(await isAppBackgrounded())) {
    return;
  }

  let permissionGranted = false;
  try {
    permissionGranted = await isPermissionGranted();
  } catch (error) {
    frontendLogger.debug("frontend.notification", "notification_permission_check_failed", {
      error,
    });
  }

  if (!permissionGranted) {
    return;
  }

  try {
    sendNotification({
      body: options.body,
      id: options.tag ? notificationIdForTag(options.tag) : undefined,
      title: options.title,
    });
  } catch (error) {
    frontendLogger.debug("frontend.notification", "notification_failed", { error });
  }
}
