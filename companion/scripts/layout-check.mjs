import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const tabs = ['Haptics', 'Audio', 'Triggers', 'Lighting', 'System'];
const testButtonTabs = ['Haptics', 'Audio', 'Triggers'];
const tolerancePx = 1;
const buttonTolerancePx = 2;

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: {
    ...process.env,
    DS5_BRIDGE_ALLOW_PARALLEL_AUTOMATION_INSTANCE: '1'
  }
});

try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.hero-card', { timeout: 10000 });
  await page.waitForTimeout(250);
  const controlsNav = page.getByRole('tablist', { name: 'Controls' });

  const failures = [];
  const rows = [];
  const buttonRows = [];
  const audioHapticsRows = [];
  const audioHapticsSelectorRows = [];
  const audioHapticsConfigControlRows = [];
  const systemTypographyRows = [];
  let targetHeight = null;
  let targetIconLeft = null;
  let targetTextLeft = null;

  for (const tab of tabs) {
    await controlsNav.getByRole('tab', { name: tab }).click();
    await page.waitForTimeout(150);

    const measurement = await page.evaluate(() => {
      const activePage = document.querySelector('.control-page.active');
      const cards = activePage ? [...activePage.querySelectorAll('.feature-card-grid > section')] : [];
      return cards.map((card) => {
        const rect = card.getBoundingClientRect();
        return {
          className: card.className,
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height
        };
      });
    });

    if (measurement.length !== 2) {
      failures.push(`${tab}: expected 2 cards, found ${measurement.length}`);
      continue;
    }

    const [left, right] = measurement;
    const bottomDelta = Math.abs(left.bottom - right.bottom);
    const heightDelta = Math.abs(left.height - right.height);
    rows.push({
      tab,
      leftHeight: Number(left.height.toFixed(2)),
      rightHeight: Number(right.height.toFixed(2)),
      bottomDelta: Number(bottomDelta.toFixed(2))
    });

    if (bottomDelta > tolerancePx || heightDelta > tolerancePx) {
      failures.push(
        `${tab}: columns differ by ${heightDelta.toFixed(2)}px height and ${bottomDelta.toFixed(2)}px bottom`
      );
    }

    targetHeight ??= left.height;
    const tabHeightDelta = Math.abs(left.height - targetHeight);
    if (tabHeightDelta > tolerancePx) {
      failures.push(`${tab}: card height differs from other tabs by ${tabHeightDelta.toFixed(2)}px`);
    }
  }

  await controlsNav.getByRole('tab', { name: 'Haptics' }).click();
  await page.waitForTimeout(150);
  await page.getByRole('switch', { name: 'Enter Audio Haptics' }).click();
  await page.waitForTimeout(150);

  const audioHapticsMeasurement = await page.evaluate(() => {
    const activePage = document.querySelector('.control-page.active');
    const cards = [...(activePage?.querySelectorAll('.audio-haptics-grid > section') ?? [])].map((card) => {
      const rect = card.getBoundingClientRect();
      return {
        className: card.className,
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        scrollHeight: card.scrollHeight,
        clientHeight: card.clientHeight
      };
    });
    const leftChildren = [...(activePage?.querySelectorAll('.audio-haptics-card:first-child > *') ?? [])].map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        className: element.className,
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height
      };
    });
    const selectors = [...(activePage?.querySelectorAll('.audio-haptics-routing-stack .dual-selector') ?? [])].map((selector) => {
      const rect = selector.getBoundingClientRect();
      const buttons = [...selector.querySelectorAll('button')].map((button) => {
        const buttonRect = button.getBoundingClientRect();
        return {
          label: button.textContent.trim(),
          left: buttonRect.left,
          right: buttonRect.right,
          width: buttonRect.width
        };
      });
      const firstButton = buttons[0];
      const lastButton = buttons[buttons.length - 1];
      return {
        label: selector.getAttribute('aria-label') ?? '',
        width: rect.width,
        buttonCount: buttons.length,
        buttonWidthDelta: Math.max(...buttons.map((button) => Math.abs(button.width - buttons[0].width))),
        firstLeftGap: firstButton ? firstButton.left - rect.left : 0,
        lastRightGap: lastButton ? rect.right - lastButton.right : 0
      };
    });
    const configControls = [...(activePage?.querySelectorAll('.audio-haptics-config-pair-row label') ?? [])].map((label) => {
      const select = label.querySelector('.custom-select-button');
      const labelRect = label.getBoundingClientRect();
      const selectRect = select?.getBoundingClientRect();
      return {
        label: label.querySelector('span')?.textContent?.trim() ?? '',
        width: labelRect.width,
        selectWidth: selectRect?.width ?? 0,
        selectHeight: selectRect?.height ?? 0,
        text: select?.textContent?.trim() ?? ''
      };
    });

    return {
      cards,
      leftChildren,
      selectors,
      configControls
    };
  });

  if (audioHapticsMeasurement.cards.length !== 2) {
    failures.push(`Audio Haptics: expected 2 cards, found ${audioHapticsMeasurement.cards.length}`);
  } else {
    const [left, right] = audioHapticsMeasurement.cards;
    const bottomDelta = Math.abs(left.bottom - right.bottom);
    const heightDelta = Math.abs(left.height - right.height);
    audioHapticsRows.push({
      tab: 'Audio Haptics',
      leftHeight: Number(left.height.toFixed(2)),
      rightHeight: Number(right.height.toFixed(2)),
      bottomDelta: Number(bottomDelta.toFixed(2)),
      leftOverflow: left.scrollHeight - left.clientHeight,
      rightOverflow: right.scrollHeight - right.clientHeight
    });

    if (bottomDelta > tolerancePx || heightDelta > tolerancePx) {
      failures.push(
        `Audio Haptics: columns differ by ${heightDelta.toFixed(2)}px height and ${bottomDelta.toFixed(2)}px bottom`
      );
    }

    if (targetHeight !== null && Math.abs(left.height - targetHeight) > tolerancePx) {
      failures.push(`Audio Haptics: card height differs from other tabs by ${Math.abs(left.height - targetHeight).toFixed(2)}px`);
    }

    for (const card of audioHapticsMeasurement.cards) {
      const overflow = card.scrollHeight - card.clientHeight;
      if (overflow > tolerancePx) {
        failures.push(`Audio Haptics ${card.className}: content overflows by ${overflow.toFixed(2)}px`);
      }
    }
  }

  for (let index = 1; index < audioHapticsMeasurement.leftChildren.length; index += 1) {
    const previous = audioHapticsMeasurement.leftChildren[index - 1];
    const current = audioHapticsMeasurement.leftChildren[index];
    if (previous.bottom - current.top > tolerancePx) {
      failures.push(`Audio Haptics ${current.className}: overlaps previous control by ${(previous.bottom - current.top).toFixed(2)}px`);
    }
  }

  for (const selector of audioHapticsMeasurement.selectors) {
    audioHapticsSelectorRows.push({
      label: selector.label,
      width: Number(selector.width.toFixed(2)),
      buttonCount: selector.buttonCount,
      buttonWidthDelta: Number(selector.buttonWidthDelta.toFixed(2)),
      firstLeftGap: Number(selector.firstLeftGap.toFixed(2)),
      lastRightGap: Number(selector.lastRightGap.toFixed(2))
    });

    if (selector.buttonCount !== 2) {
      failures.push(`Audio Haptics ${selector.label}: expected 2 selector buttons, found ${selector.buttonCount}`);
    }

    if (selector.buttonWidthDelta > tolerancePx) {
      failures.push(`Audio Haptics ${selector.label}: selector button widths differ by ${selector.buttonWidthDelta.toFixed(2)}px`);
    }

    if (selector.firstLeftGap > buttonTolerancePx || selector.lastRightGap > buttonTolerancePx) {
      failures.push(
        `Audio Haptics ${selector.label}: selector buttons leave ${selector.firstLeftGap.toFixed(2)}px/${selector.lastRightGap.toFixed(2)}px side gaps`
      );
    }
  }

  for (const control of audioHapticsMeasurement.configControls) {
    audioHapticsConfigControlRows.push({
      label: control.label,
      width: Number(control.width.toFixed(2)),
      selectWidth: Number(control.selectWidth.toFixed(2)),
      selectHeight: Number(control.selectHeight.toFixed(2)),
      text: control.text
    });

    if (control.selectWidth < 150) {
      failures.push(`Audio Haptics ${control.label}: dropdown is too narrow at ${control.selectWidth.toFixed(2)}px`);
    }

    if (control.selectHeight < 32) {
      failures.push(`Audio Haptics ${control.label}: dropdown is too short at ${control.selectHeight.toFixed(2)}px`);
    }
  }

  await page.getByRole('switch', { name: 'Exit Audio Haptics' }).click();
  await page.waitForTimeout(150);

  for (const tab of testButtonTabs) {
    await controlsNav.getByRole('tab', { name: tab }).click();
    await page.waitForTimeout(150);

    const measurements = await page.evaluate(() => {
      const activePage = document.querySelector('.control-page.active');
      const buttons = [
        ...(activePage?.querySelectorAll(
          '.test-card > .primary-action, ' +
          '.test-card > .secondary-action, ' +
          '.trigger-action-row .primary-action, ' +
          '.trigger-action-row .secondary-action'
        ) ?? [])
      ];

      function textRectFor(button) {
        const range = document.createRange();
        const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
        let firstText = null;
        let lastText = null;
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node.textContent.trim().length === 0) {
            continue;
          }
          firstText ??= node;
          lastText = node;
        }

        if (!firstText || !lastText) {
          return null;
        }

        range.setStart(firstText, 0);
        range.setEnd(lastText, lastText.textContent.length);
        const rect = range.getBoundingClientRect();
        range.detach();
        return rect;
      }

      return buttons.map((button) => {
        const buttonRect = button.getBoundingClientRect();
        const icon = button.querySelector('svg, .stop-glyph');
        const iconRect = icon?.getBoundingClientRect();
        const textRect = textRectFor(button);
        const groupLeft = Math.min(iconRect?.left ?? buttonRect.left, textRect?.left ?? buttonRect.left);
        const groupRight = Math.max(iconRect?.right ?? buttonRect.right, textRect?.right ?? buttonRect.right);
        const groupTop = Math.min(iconRect?.top ?? buttonRect.top, textRect?.top ?? buttonRect.top);
        const groupBottom = Math.max(iconRect?.bottom ?? buttonRect.bottom, textRect?.bottom ?? buttonRect.bottom);

        return {
          label: button.textContent.trim().replace(/\s+/g, ' '),
          buttonWidth: buttonRect.width,
          buttonCenterX: buttonRect.left + buttonRect.width / 2,
          buttonCenterY: buttonRect.top + buttonRect.height / 2,
          groupCenterX: (groupLeft + groupRight) / 2,
          groupCenterY: (groupTop + groupBottom) / 2,
          iconWidth: iconRect?.width ?? 0,
          iconHeight: iconRect?.height ?? 0,
          iconCenterY: iconRect ? iconRect.top + iconRect.height / 2 : 0,
          textHeight: textRect?.height ?? 0,
          textLeft: textRect?.left ?? 0,
          iconRight: iconRect?.right ?? 0
        };
      });
    });

    if (measurements.length !== 2) {
      failures.push(`${tab}: expected 2 test action buttons, found ${measurements.length}`);
      continue;
    }

    for (const measurement of measurements) {
      const groupVerticalDelta = Math.abs(measurement.groupCenterY - measurement.buttonCenterY);
      const iconVerticalDelta = Math.abs(measurement.iconCenterY - measurement.buttonCenterY);
      const iconSizeDelta = Math.max(Math.abs(measurement.iconWidth - 24), Math.abs(measurement.iconHeight - 24));
      const iconTextGap = measurement.textLeft - measurement.iconRight;
      const iconLeft = measurement.iconRight - measurement.iconWidth;
      const iconLeftOffset = iconLeft - (measurement.buttonCenterX - measurement.buttonWidth / 2);
      const textLeftOffset = measurement.textLeft - (measurement.buttonCenterX - measurement.buttonWidth / 2);
      targetIconLeft ??= iconLeftOffset;
      targetTextLeft ??= textLeftOffset;

      buttonRows.push({
        tab,
        label: measurement.label,
        iconSize: `${measurement.iconWidth.toFixed(0)}x${measurement.iconHeight.toFixed(0)}`,
        iconTextGap: Number(iconTextGap.toFixed(2)),
        iconLeft: Number(iconLeftOffset.toFixed(2)),
        textLeft: Number(textLeftOffset.toFixed(2)),
        textHeight: Number(measurement.textHeight.toFixed(2)),
        verticalDelta: Number(groupVerticalDelta.toFixed(2))
      });

      if (iconSizeDelta > tolerancePx) {
        failures.push(`${tab} ${measurement.label}: icon badge is ${measurement.iconWidth.toFixed(2)}x${measurement.iconHeight.toFixed(2)}px`);
      }

      if (iconTextGap < 10 || iconTextGap > 14) {
        failures.push(`${tab} ${measurement.label}: icon/text gap is ${iconTextGap.toFixed(2)}px`);
      }

      if (Math.abs(iconLeftOffset - targetIconLeft) > tolerancePx) {
        failures.push(`${tab} ${measurement.label}: icon left offset is ${iconLeftOffset.toFixed(2)}px, expected ${targetIconLeft.toFixed(2)}px`);
      }

      if (Math.abs(textLeftOffset - targetTextLeft) > tolerancePx) {
        failures.push(`${tab} ${measurement.label}: text left offset is ${textLeftOffset.toFixed(2)}px, expected ${targetTextLeft.toFixed(2)}px`);
      }

      if (measurement.textHeight > 24) {
        failures.push(`${tab} ${measurement.label}: text appears wrapped at ${measurement.textHeight.toFixed(2)}px tall`);
      }

      if (groupVerticalDelta > buttonTolerancePx || iconVerticalDelta > buttonTolerancePx) {
        failures.push(`${tab} ${measurement.label}: icon/text vertical alignment is off by ${Math.max(groupVerticalDelta, iconVerticalDelta).toFixed(2)}px`);
      }
    }
  }

  await controlsNav.getByRole('tab', { name: 'System' }).click();
  await page.waitForTimeout(150);

  const systemTypography = await page.evaluate(() => {
    const activePage = document.querySelector('.control-page.active');

    function read(selector) {
      return [...(activePage?.querySelectorAll(selector) ?? [])].map((element) => ({
        text: element.textContent.trim().replace(/\s+/g, ' '),
        fontSize: Number.parseFloat(getComputedStyle(element).fontSize)
      }));
    }

    return {
      muteLabels: read('.system-fields .select-row > span'),
      deviceLabels: read('.device-row > span'),
      systemSelectValues: read('.system-page .custom-select-button span')
    };
  });

  const typographySamples = [
    ...systemTypography.muteLabels.map((sample) => ({ group: 'mute label', ...sample })),
    ...systemTypography.deviceLabels.map((sample) => ({ group: 'device label', ...sample })),
    ...systemTypography.systemSelectValues.map((sample) => ({ group: 'select value', ...sample }))
  ];
  const targetSystemFontSize = typographySamples[0]?.fontSize ?? 0;

  for (const sample of typographySamples) {
    systemTypographyRows.push({
      group: sample.group,
      text: sample.text,
      fontSize: sample.fontSize
    });

    if (Math.abs(sample.fontSize - targetSystemFontSize) > 0.25) {
      failures.push(
        `System ${sample.group} "${sample.text}" font size is ${sample.fontSize}px, expected ${targetSystemFontSize}px`
      );
    }
  }

  console.table(rows);
  console.table(audioHapticsRows);
  console.table(audioHapticsSelectorRows);
  console.table(audioHapticsConfigControlRows);
  console.table(buttonRows);
  console.table(systemTypographyRows);

  if (failures.length > 0) {
    throw new Error(`Layout check failed:\n${failures.join('\n')}`);
  }
} finally {
  await app.close();
}
