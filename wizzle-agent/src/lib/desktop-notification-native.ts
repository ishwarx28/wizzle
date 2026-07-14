export type NotificationCommandInvoker = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

type NativeNotificationOptions = {
  body: string;
  id?: number;
  title: string;
};

export async function isNativeNotificationPermissionGranted(
  invokeCommand: NotificationCommandInvoker,
) {
  return (await invokeCommand("plugin:notification|is_permission_granted")) === true;
}

export async function requestNativeNotificationPermission(
  invokeCommand: NotificationCommandInvoker,
) {
  return (await invokeCommand("plugin:notification|request_permission")) === "granted";
}

export async function sendNativeNotification(
  invokeCommand: NotificationCommandInvoker,
  options: NativeNotificationOptions,
) {
  await invokeCommand("plugin:notification|notify", { options });
}
