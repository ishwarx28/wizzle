import {
  isNativeNotificationPermissionGranted,
  requestNativeNotificationPermission,
  sendNativeNotification,
  type NotificationCommandInvoker,
} from "./desktop-notification-native.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const commands: string[] = [];
  const permissionCheckInvoker: NotificationCommandInvoker = async (command) => {
    commands.push(command);
    return true;
  };

  assert(
    await isNativeNotificationPermissionGranted(permissionCheckInvoker),
    "native permission check reports granted",
  );
  assert(
    commands[0] === "plugin:notification|is_permission_granted",
    "uses the native permission check command",
  );

  const permissionRequestInvoker: NotificationCommandInvoker = async (command) => {
    assert(
      command === "plugin:notification|request_permission",
      "uses the native permission request command",
    );
    return "granted";
  };

  assert(
    await requestNativeNotificationPermission(permissionRequestInvoker),
    "native permission request reports granted",
  );

  const calls: Array<{ args?: Record<string, unknown>; command: string }> = [];
  const notificationInvoker: NotificationCommandInvoker = async (command, args) => {
    calls.push({ args, command });
    return undefined;
  };

  await sendNativeNotification(notificationInvoker, {
    body: "Approval required",
    id: 42,
    title: "Wizzle needs your attention",
  });

  assert(calls.length === 1, "sends one native notification command");
  assert(calls[0]?.command === "plugin:notification|notify", "uses the native notify command");
  assert(
    JSON.stringify(calls[0]?.args) ===
      JSON.stringify({
        options: {
          body: "Approval required",
          id: 42,
          title: "Wizzle needs your attention",
        },
      }),
    "passes the notification data to the native command",
  );

  console.log("desktop notification native tests passed");
}

void main();
