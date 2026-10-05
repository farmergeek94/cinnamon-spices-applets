# Claude Subscription Usage

A panel applet that shows how much of your Claude subscription's usage limits you have used: the current session, the current week, and any model-specific weekly limits.

These are the limits of a Claude Pro or Max plan, the same figures as `/usage` in Claude Code and the usage page on claude.ai. It does not report API (pay-per-token) billing and does not need an API key.

## Features

- The panel shows the percentage used of the current session, with a small usage bar. It can show the time left until the limit resets, and it can follow the weekly limit, or whichever limit is highest, instead.
- The text and the bar turn amber and then red as a limit fills up.
- Click the applet for every limit, each with a bar, a live countdown to its reset and the time of the reset, plus extra usage spend and your plan.
- If a reading cannot be refreshed, the last one stays on screen, dimmed, with a plain explanation of what is wrong and when the applet will try again.
- Middle-click the applet, or use the button in the menu, to check right away.

## Requirements

- [Claude Code](https://claude.com/claude-code) installed and signed in with a Claude subscription. The applet reads the sign-in that Claude Code keeps in `~/.claude/.credentials.json`; a different file can be chosen in the settings.
- Internet access.
- A Cinnamon version that uses libsoup 3. Developed and tested on Cinnamon 6.6.

## How it works

The applet reads the sign-in token from the Claude Code credentials file and uses it to ask `api.anthropic.com` for your usage and your plan. It only ever reads that file. The token is sent to nowhere else and is not stored or logged, and the applet keeps nothing but the last reading (percentages, reset times and the plan name) in its own settings.

Claude limits how often usage can be checked, so the default is every 3 minutes. If the applet reports being rate limited it backs off on its own; raising the interval in the settings avoids it.

Claude Code is what renews the sign-in. If you have not used Claude Code for some hours the sign-in expires and the applet says so; it recovers on its own as soon as you use Claude Code again.

The usage endpoint is not a documented API and could change without notice. If it does, the applet will show the reading as unavailable until it is updated.

## Credits

Inspired by the [AI Usage Desklet](https://github.com/chloecaffeinexo/ai-usage-desklet) by chloecaffeinexo.

This is an independent project and is not affiliated with or endorsed by Anthropic. "Claude" is a trademark of Anthropic.
