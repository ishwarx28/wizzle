import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  isNativeNotificationPermissionGranted,
  type NotificationCommandInvoker,
  requestNativeNotificationPermission,
  sendNativeNotification,
} from "./desktop-notification-native";
import { frontendLogger } from "./logger";

type DesktopNotificationOptions = {
  body: string;
  tag?: string;
  title: string;
};

let didRequestNotificationPermission = false;

const invokeNotificationCommand: NotificationCommandInvoker = (command, args) =>
  invoke(command, args);

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

function notificationIdForTag(tag: string) {
  let hash = 0;
  for (let index = 0; index < tag.length; index += 1) {
    hash = (Math.imul(hash, 31) + tag.charCodeAt(index)) | 0;
  }
  return ((hash >>> 0) % 2_147_483_647) || 1;
}

export async function requestNotificationPermissionForUserGesture() {
  try {
    if (await isNativeNotificationPermissionGranted(invokeNotificationCommand)) {
      return true;
    }
  } catch (error) {
    frontendLogger.debug("frontend.notification", "notification_permission_check_failed", {
      error,
    });
  }

  if (didRequestNotificationPermission) {
    return false;
  }

  didRequestNotificationPermission = true;

  try {
    return await requestNativeNotificationPermission(invokeNotificationCommand);
  } catch (error) {
    didRequestNotificationPermission = false;
    frontendLogger.debug("frontend.notification", "notification_permission_request_failed", {
      error,
    });
    return false;
  }
}

export async function notifyWhenAppBackgrounded(options: DesktopNotificationOptions) {
  if (!(await isAppBackgrounded())) {
    return;
  }

  let permissionGranted = false;
  try {
    permissionGranted = await isNativeNotificationPermissionGranted(
      invokeNotificationCommand,
    );
  } catch (error) {
    frontendLogger.debug("frontend.notification", "notification_permission_check_failed", {
      error,
    });
  }

  if (!permissionGranted) {
    return;
  }

  try {
    await sendNativeNotification(invokeNotificationCommand, {
      body: options.body,
      id: options.tag ? notificationIdForTag(options.tag) : undefined,
      title: options.title,
    });
  } catch (error) {
    frontendLogger.debug("frontend.notification", "notification_failed", { error });
  }
}
