// PS5 13.20 VshNMNotificationModule.Send takes an object payload, not JSON.
// The native dictionary bridge serializes it for sceNotificationSend.
export function createPlaybackNotifications({
  baseRequire,
  isRuntimeCurrent,
} = {}) {
  const record = baseRequire?.c?.bX5JscBE,
    modules = record?.exports;
  const notification = modules?.VshNMNotificationModule,
    send = notification?.Send;
  if (!record || record.l !== true || typeof send !== "function")
    return () => undefined;
  let sequence = 0;
  return (track) => {
    if (
      !isRuntimeCurrent() ||
      baseRequire.c.bX5JscBE !== record ||
      record.exports !== modules ||
      modules.VshNMNotificationModule !== notification ||
      notification.Send !== send
    )
      return;
    const name =
      typeof track?.name === "string" ? track.name.slice(0, 240) : "Tu música";
    const artist =
      typeof track?.artist === "string" ? track.artist.slice(0, 240) : "";
    // Native TemplateB places subMessage above the main title. No action takes
    // controller focus, and no notification sound interrupts the song.
    return Reflect.apply(send, notification, [
      {
        userId: 254,
        logged: true,
        payload: {
          rawData: {
            viewTemplateType: "InteractiveToastTemplateB",
            channelType: "ServiceFeedback",
            bundleName: "NaviStation5NowPlaying",
            useCaseId: "IDC",
            soundEffect: "none",
            toastOverwriteType: "InQueue",
            isImmediate: true,
            priority: 100,
            viewData: {
              icon: { type: "Predefined", parameters: { icon: "music" } },
              message: { body: name },
              subMessage: { body: artist || "NaviStation5" },
              actions: [],
            },
          },
          createdDateTime: new Date().toISOString(),
          localNotificationId: `${Date.now()}-${++sequence}`,
        },
      },
    ]);
  };
}
