// Initially ported & inspired by https://github.com/golang/vscode-go/blob/master/src/goCover.ts to provide consistent
// coverage highlighting.

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  CoverageFile,
  LineCoverage,
  LineCoverageStatus,
  ResultMerger,
  SourceFile,
} from "./coverage";

let gutterSvgs: { [key: string]: string };

const outputChannel = vscode.window.createOutputChannel("Simplecov");

interface Highlight {
  top: vscode.TextEditorDecorationType;
  mid: vscode.TextEditorDecorationType;
  bot: vscode.TextEditorDecorationType;
  all: vscode.TextEditorDecorationType;
}

interface Decorator {
  type: "highlight" | "gutter";
  coveredHighlight: Highlight;
  coveredGutter: vscode.TextEditorDecorationType;
  uncoveredHighlight: Highlight;
  uncoveredGutter: vscode.TextEditorDecorationType;
  uncoveredBranchHighlight: Highlight;
  uncoveredBranchGutter: vscode.TextEditorDecorationType;
}
let decorators: Decorator;
let statusBarItem: vscode.StatusBarItem;

interface DecoratorConfig {
  [key: string]: any;
  type: "highlight" | "gutter";
  coveredHighlightColor: string;
  coveredGutterStyle: string;
  uncoveredHighlightColor: string;
  uncoveredGutterStyle: string;
  uncoveredBranchHighlightColor: string;
  uncoveredBranchGutterStyle: string;
}

let decoratorConfig: DecoratorConfig = {
  type: "highlight",
  coveredHighlightColor: "rgba(64,128,128,0.5)",
  coveredGutterStyle: "blockgreen",
  uncoveredHighlightColor: "rgba(128,64,64,0.45)",
  uncoveredGutterStyle: "blockred",
  uncoveredBranchHighlightColor: "rgba(128,64,64,0.25)",
  uncoveredBranchGutterStyle: "blockred",
};

let coverageFiles: Map<string, SourceFile> = new Map();
let isCoverageApplied = false;

export function activate(context: vscode.ExtensionContext) {
  parseCoverageRanges();
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left
  );

  initCoverageDecorators(context);

  addWorkspaceFileSystemWatchers(context);
  addOnDidChangeConfigListeners(context);
  addOnChangeActiveTextEditorListeners(context);
  addOnSaveTextDocumentListeners(context);

  console.debug("simplecov extension activated");
}

// This method is called when your extension is deactivated
export function deactivate() {
  statusBarItem.dispose();
}

export function addWorkspaceFileSystemWatchers(
  context: vscode.ExtensionContext
) {
  const coverageDirectory = getConfig().get("coverageDirectory") as string;
  const jsonWatcher = vscode.workspace.createFileSystemWatcher(
    `**/${coverageDirectory}/*.json`
  );

  jsonWatcher.onDidChange((uri) => {
    outputChannel.appendLine(
      `Coverage JSON changed: ${uri.fsPath}, reloading…`
    );

    if (isCoverageApplied) {
      reloadCoverage();
    } else {
      parseCoverageRanges();
    }
  });

  jsonWatcher.onDidCreate((uri) => {
    outputChannel.appendLine(
      `Coverage JSON created: ${uri.fsPath}, reloading…`
    );

    parseCoverageRanges();
  });

  jsonWatcher.onDidDelete((uri) => {
    outputChannel.appendLine(
      `Coverage JSON deleted: ${uri.fsPath}, reloading…`
    );

    clearCoverage();
  });

  context.subscriptions.push(jsonWatcher);
}

function addOnChangeActiveTextEditorListeners(
  context: vscode.ExtensionContext
) {
  if (vscode.window.activeTextEditor) {
    setDecorators();
    applyCodeCoverage(vscode.window.activeTextEditor);
  }

  vscode.window.onDidChangeActiveTextEditor(
    (editor) => {
      if (editor) {
        setDecorators();
        applyCodeCoverage(editor);
      }
    },
    null,
    context.subscriptions
  );
}

function addOnSaveTextDocumentListeners(context: vscode.ExtensionContext) {
  vscode.workspace.onDidSaveTextDocument(
    removeCodeCoverageOnFileSave,
    null,
    context.subscriptions
  );
}

function addOnDidChangeConfigListeners(context: vscode.ExtensionContext) {
  vscode.workspace.onDidChangeConfiguration(
    (e: vscode.ConfigurationChangeEvent) => {
      if (!e.affectsConfiguration("simplecov")) {
        return;
      }

      const updatedConfig = getConfig();

      if (e.affectsConfiguration("simplecov.coverageDecorator")) {
        outputChannel.appendLine(
          "simplecov.coverageDecorator changed, updating…"
        );
        updateCodeCoverageDecorators(updatedConfig["coverageDecorator"]);
      }
    },
    null,
    context.subscriptions
  );
}

function updateCodeCoverageDecorators(coverageDecoratorConfig: any) {
  // Update from configuration.
  if (typeof coverageDecoratorConfig !== "object") {
    vscode.window.showWarningMessage(
      "invalid simplecov.coverageDecorator type, expected an 'object'"
    );
  } else {
    for (const k in coverageDecoratorConfig) {
      if (coverageDecoratorConfig.hasOwnProperty(k)) {
        decoratorConfig[k] = coverageDecoratorConfig[k];
      } else {
        vscode.window.showWarningMessage(`invalid coverage parameter ${k}`);
      }
    }
  }

  setDecorators();
  vscode.window.visibleTextEditors.forEach(applyCodeCoverage);
}

function initCoverageDecorators(ctx: vscode.ExtensionContext) {
  gutterSvgs = {
    blockred: ctx.asAbsolutePath("assets/gutter-blockred.svg"),
    blockgreen: ctx.asAbsolutePath("assets/gutter-blockgreen.svg"),
    blockblue: ctx.asAbsolutePath("assets/gutter-blockblue.svg"),
    blockyellow: ctx.asAbsolutePath("assets/gutter-blockyellow.svg"),
    slashred: ctx.asAbsolutePath("assets/gutter-slashred.svg"),
    slashgreen: ctx.asAbsolutePath("assets/gutter-slashgreen.svg"),
    slashblue: ctx.asAbsolutePath("assets/gutter-slashblue.svg"),
    slashyellow: ctx.asAbsolutePath("assets/gutter-slashyellow.svg"),
    verticalred: ctx.asAbsolutePath("assets/gutter-vertred.svg"),
    verticalgreen: ctx.asAbsolutePath("assets/gutter-vertgreen.svg"),
    verticalblue: ctx.asAbsolutePath("assets/gutter-vertblue.svg"),
    verticalyellow: ctx.asAbsolutePath("assets/gutter-vertyellow.svg"),
  };

  const config = getConfig();
  updateCodeCoverageDecorators(config.get("coverageDecorator"));
}

function setDecorators() {
  disposeDecorators();
  const f = (
    x: { overviewRulerColor: string; backgroundColor: string },
    arg: string
  ) => {
    const y = {
      overviewRulerLane: 2,
    };
    return Object.assign(y, x);
  };
  const coveredStyle = {
    overviewRulerColor: "green",
    backgroundColor: decoratorConfig.coveredHighlightColor,
  };
  const uncoveredStyle = {
    overviewRulerColor: "red",
    backgroundColor: decoratorConfig.uncoveredHighlightColor,
  };
  const uncoveredBranchStyle = {
    overviewRulerColor: "red",
    backgroundColor: decoratorConfig.uncoveredBranchHighlightColor,
  };
  const coveredAll = f(coveredStyle, "solid solid solid solid");
  const coveredTop = f(coveredStyle, "solid solid none solid");
  const coveredMid = f(coveredStyle, "none solid none solid");
  const coveredBot = f(coveredStyle, "none solid solid solid");
  const uncoveredTop = f(uncoveredStyle, "solid solid none solid");
  const uncoveredMid = f(uncoveredStyle, "none solid none solid");
  const uncoveredBot = f(uncoveredStyle, "none solid solid solid");
  const uncoveredAll = f(uncoveredStyle, "solid solid solid solid");
  const uncoveredBranchTop = f(uncoveredBranchStyle, "solid solid none solid");
  const uncoveredBranchMid = f(uncoveredBranchStyle, "none solid none solid");
  const uncoveredBranchBot = f(uncoveredBranchStyle, "none solid solid solid");
  const uncoveredBranchAll = f(uncoveredBranchStyle, "solid solid solid solid");
  decorators = {
    type: decoratorConfig.type,
    coveredGutter: vscode.window.createTextEditorDecorationType({
      gutterIconPath: gutterSvgs[decoratorConfig.coveredGutterStyle],
    }),
    uncoveredGutter: vscode.window.createTextEditorDecorationType({
      gutterIconPath: gutterSvgs[decoratorConfig.uncoveredGutterStyle],
    }),
    uncoveredBranchGutter: vscode.window.createTextEditorDecorationType({
      gutterIconPath: gutterSvgs[decoratorConfig.uncoveredBranchGutterStyle],
    }),
    coveredHighlight: {
      all: vscode.window.createTextEditorDecorationType(coveredAll),
      top: vscode.window.createTextEditorDecorationType(coveredTop),
      mid: vscode.window.createTextEditorDecorationType(coveredMid),
      bot: vscode.window.createTextEditorDecorationType(coveredBot),
    },
    uncoveredHighlight: {
      all: vscode.window.createTextEditorDecorationType(uncoveredAll),
      top: vscode.window.createTextEditorDecorationType(uncoveredTop),
      mid: vscode.window.createTextEditorDecorationType(uncoveredMid),
      bot: vscode.window.createTextEditorDecorationType(uncoveredBot),
    },
    uncoveredBranchHighlight: {
      all: vscode.window.createTextEditorDecorationType(uncoveredBranchAll),
      top: vscode.window.createTextEditorDecorationType(uncoveredBranchTop),
      mid: vscode.window.createTextEditorDecorationType(uncoveredBranchMid),
      bot: vscode.window.createTextEditorDecorationType(uncoveredBranchBot),
    },
  };
}

function disposeDecorators() {
  if (decorators) {
    decorators.coveredGutter.dispose();
    decorators.uncoveredGutter.dispose();
    decorators.uncoveredBranchGutter.dispose();
    decorators.coveredHighlight.all.dispose();
    decorators.coveredHighlight.top.dispose();
    decorators.coveredHighlight.mid.dispose();
    decorators.coveredHighlight.bot.dispose();
    decorators.uncoveredHighlight.all.dispose();
    decorators.uncoveredHighlight.top.dispose();
    decorators.uncoveredHighlight.mid.dispose();
    decorators.uncoveredHighlight.bot.dispose();
    decorators.uncoveredBranchHighlight.all.dispose();
    decorators.uncoveredBranchHighlight.top.dispose();
    decorators.uncoveredBranchHighlight.mid.dispose();
    decorators.uncoveredBranchHighlight.bot.dispose();
  }
}

function clearCoverage() {
  outputChannel.appendLine(`Clearing coverage`);

  coverageFiles.clear();
  statusBarItem.hide();
  disposeDecorators();
  isCoverageApplied = false;
}

function reloadCoverage() {
  console.debug("clearCoverage");
  outputChannel.appendLine(`Reloading coverage`);

  clearCoverage();
  setDecorators();
  parseCoverageRanges();
}

function removeCodeCoverageOnFileSave(e: vscode.TextDocument) {
  if (e.languageId !== "ruby") {
    console.debug(
      `removeCodeCoverageOnFileSave: expected ruby, got ${e.languageId}`
    );
    return;
  }

  if (!isCoverageApplied) {
    console.debug(
      `removeCodeCoverageOnFileSave: coverage not applied, skipping ${e.fileName}`
    );
    return;
  }

  if (
    vscode.window.visibleTextEditors.every((editor) => editor.document !== e)
  ) {
    return;
  }

  clearCoverage();
}

function applyCodeCoverage(editor: vscode.TextEditor | undefined) {
  if (!editor) {
    return;
  }

  if (editor.document.languageId !== "ruby") {
    console.debug(
      `applyCodeCoverage: expected file with Ruby as the language, got ${editor.document.languageId}`
    );
    return;
  }

  if (editor.document.fileName.endsWith("_test.rb")) {
    console.debug(`applyCodeCoverage: no coverage needed on test file`);
    return;
  }

  const fileName = editor.document.fileName;
  const cfg = getConfig(editor.document.uri);
  const sourceFile = coverageFiles.get(fileName);

  if (!sourceFile) {
    outputChannel.appendLine(`No coverage information found for ${fileName}`);
    statusBarItem.hide();
    return;
  }

  outputChannel.appendLine(`Applying coverage for ${fileName}`);
  isCoverageApplied = true;

  // Status Bar Item
  const stats = sourceFile.coverageStatistics;
  let statusIcon = "$(x)";
  if (stats.percentage > 90) {
    statusIcon = "$(check)";
  } else if (stats.percentage > 80) {
    statusIcon = "$(alert)";
  }
  statusBarItem.tooltip = `${stats.totalLines} relevant lines. ${stats.coveredLines} covered, ${stats.uncoveredLines} missed.`;
  statusBarItem.text = `${statusIcon} ${stats.percentage.toFixed()}%`;
  statusBarItem.show();

  // Line decorators
  const coveredDecorations: vscode.DecorationOptions[] = [];
  const uncoveredDecorations: vscode.DecorationOptions[] = [];
  const uncoveredBranchesDecorations: vscode.DecorationOptions[] = [];
  const showCounts = getConfig().get("coverShowCounts") as boolean;

  for (const [index, line] of sourceFile.lines.entries()) {
    const range = new vscode.Range(index, 0, index, Number.MAX_SAFE_INTEGER);

    if (line.status === LineCoverageStatus.Covered) {
      coveredDecorations.push(...elaborate(range, line, showCounts));
    } else if (line.status === LineCoverageStatus.Uncovered) {
      if (line.branches.length) {
        uncoveredBranchesDecorations.push(
          ...elaborate(range, line, showCounts)
        );
      } else {
        uncoveredDecorations.push(...elaborate(range, line, showCounts));
      }
    }
  }

  const coverageOptions = cfg["coverageOptions"];

  if (
    coverageOptions === "showCoveredCodeOnly" ||
    coverageOptions === "showBothCoveredAndUncoveredCode"
  ) {
    if (decorators.type === "gutter") {
      editor.setDecorations(decorators.coveredGutter, coveredDecorations);
    } else {
      detailed(editor, decorators.coveredHighlight, coveredDecorations);
    }
  }

  if (
    coverageOptions === "showUncoveredCodeOnly" ||
    coverageOptions === "showBothCoveredAndUncoveredCode"
  ) {
    if (decorators.type === "gutter") {
      editor.setDecorations(decorators.uncoveredGutter, uncoveredDecorations);
      editor.setDecorations(
        decorators.uncoveredBranchGutter,
        uncoveredBranchesDecorations
      );
    } else {
      detailed(editor, decorators.uncoveredHighlight, uncoveredDecorations);
      detailed(
        editor,
        decorators.uncoveredBranchHighlight,
        uncoveredBranchesDecorations
      );
    }
  }
}

function parseCoverageRanges() {
  const coverageDirectory = getConfig().get("coverageDirectory") as string;
  outputChannel.appendLine(`Parsing coverage ranges`);

  coverageFiles = new Map<string, SourceFile>();
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showInformationMessage("No workspace folder found!");
      return;
    }
    const workspaceFolder = workspaceFolders[0];

    const possiblePaths = [
      path.join(workspaceFolder.uri.fsPath, coverageDirectory, "coverage.json"),
      path.join(
        workspaceFolder.uri.fsPath,
        coverageDirectory,
        ".resultset.json"
      ),
    ];

    const coverageJsonPath = possiblePaths.find(fs.existsSync);
    if (!coverageJsonPath) {
      outputChannel.appendLine(
        `No coverage file found in ${possiblePaths.join(", ")}`
      );
      return;
    }

    outputChannel.appendLine(`Found coverage file at ${coverageJsonPath}`);

    const rawData = fs.readFileSync(coverageJsonPath);
    const coverageFile = JSON.parse(rawData.toString()) as CoverageFile;
    const mergedFileCoverage = ResultMerger.merge(coverageFile);

    for (const [fileName, coverage] of Object.entries(mergedFileCoverage)) {
      const sourceFile = new SourceFile(fileName, coverage);
      coverageFiles.set(fileName, sourceFile);
    }
  } catch (e) {
    vscode.window.showInformationMessage((e as any).msg);
  }
}

function elaborate(
  r: vscode.Range,
  lineCoverage: LineCoverage,
  showCounts: boolean
): vscode.DecorationOptions[] {
  // irrelevant for "gutter"
  if (
    !decorators ||
    decorators.type === "gutter" ||
    lineCoverage.hitCount === null
  ) {
    return [{ range: r }];
  }

  const ans: vscode.DecorationOptions[] = [];
  const pluralizedHits = lineCoverage.hitCount === 1 ? "hit" : "hits";
  let after: vscode.ThemableDecorationAttachmentRenderOptions | undefined;

  if (showCounts) {
    after = {
      margin: "0 0 0 1em",
      color: new vscode.ThemeColor("editorLineNumber.foreground"),
      contentText: `${lineCoverage.hitCount} ${pluralizedHits}`,
    };
  }

  const v: vscode.DecorationOptions = {
    range: r,
    hoverMessage: `${lineCoverage.hitCount} ${pluralizedHits}`,
    renderOptions: {
      after,
    },
  };

  ans.push(v);

  lineCoverage.branches.forEach((branch) => {
    let after: vscode.ThemableDecorationAttachmentRenderOptions | undefined;
    if (branch.hitCount > 0 && showCounts) {
      after = {
        margin: "0 0 0 1em",
        color: new vscode.ThemeColor("editorLineNumber.foreground"),
        contentText: `${branch.type}: ${branch.hitCount}`,
      };
    }

    const v: vscode.DecorationOptions = {
      range: r,
      hoverMessage: `${branch.hitCount} ${branch.type}`,
      renderOptions: {
        after,
      },
    };

    ans.push(v);
  });

  return ans;
}

function detailed(
  editor: vscode.TextEditor,
  h: Highlight,
  opts: vscode.DecorationOptions[]
) {
  const tops: vscode.DecorationOptions[] = [];
  const mids: vscode.DecorationOptions[] = [];
  const bots: vscode.DecorationOptions[] = [];
  const alls: vscode.DecorationOptions[] = [];
  opts.forEach((opt) => {
    const r = opt.range;
    if (r.start.line === r.end.line) {
      alls.push(opt);
      return;
    }
    for (let line = r.start.line; line <= r.end.line; line++) {
      if (line === r.start.line) {
        const use: vscode.DecorationOptions = {
          range: editor.document.validateRange(
            new vscode.Range(
              line,
              r.start.character,
              line,
              Number.MAX_SAFE_INTEGER
            )
          ),
          hoverMessage: opt.hoverMessage,
          renderOptions: opt.renderOptions,
        };
        tops.push(use);
      } else if (line < r.end.line) {
        const use = {
          range: editor.document.validateRange(
            new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER)
          ),
          hoverMessage: opt.hoverMessage,
        };
        mids.push(use);
      } else {
        const use = {
          range: new vscode.Range(line, 0, line, r.end.character),
          hoverMessage: opt.hoverMessage,
        };
        bots.push(use);
      }
    }
  });
  if (tops.length > 0) {
    editor.setDecorations(h.top, tops);
  }
  if (mids.length > 0) {
    editor.setDecorations(h.mid, mids);
  }
  if (bots.length > 0) {
    editor.setDecorations(h.bot, bots);
  }
  if (alls.length > 0) {
    editor.setDecorations(h.all, alls);
  }
}

function getConfig(uri?: vscode.Uri | null) {
  if (!uri) {
    if (vscode.window.activeTextEditor) {
      uri = vscode.window.activeTextEditor.document.uri;
    } else {
      uri = null;
    }
  }

  return vscode.workspace.getConfiguration("simplecov", uri);
}
