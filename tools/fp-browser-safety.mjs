// All example regression browsers run headless and muted.
export async function launchSilentBrowser(browserType) {
  if (browserType.name() !== 'chromium') throw new Error('This harness supports Chromium only');
  return browserType.launch({ headless: true, args: ['--mute-audio'] });
}
