// You can find the data structures used by Simplecov for results here:
// https://github.com/simplecov-ruby/simplecov
//
// The common data structures referenced are:
// - SimpleCov::Result
// - SimpleCov::SourceFile
// - SimpleCov::SourceFile::Line
// - SimpleCov::SourceFile::Branch
// - SimpleCov::ResultMerger
// - SimpleCov::CoverageStatistics

interface BranchReport {
  type: string;
  hitCount: number;
}

interface BranchesReport {
  [reportLine: number]: BranchReport[] | null;
}

export interface SourceFile {
  fileName: string;
  lines: LineCoverage[];
  coverageStatistics: CoverageStatistics;
}

interface Branch {
  startLine: number;
  endLine: number;
  hitCount: number;
  inline: boolean;
  type: string;
  reportLine: number;
  status: LineCoverageStatus;
}

interface BranchData {
  [branchCondition: string]: {
    [branchCondition: string]: number;
  };
}

export interface CoverageFile {
  [command: string]: {
    // Likely a better name to not confuse with CoverageFile
    coverage: FileCoverage;
    timestamp: number;
  };
}

interface FileCoverage {
  [fileName: string]: Coverage;
}

interface CoverageStatistics {
  totalLines: number;
  coveredLines: number;
  uncoveredLines: number;
  strength: number;
  percentage: number;
}

type CoverageFileLine = number | null;

interface Coverage {
  lines: CoverageFileLine[];
  branches: BranchData;
}

export enum LineCoverageStatus {
  Covered = "covered",
  Uncovered = "uncovered",
  Never = "never",
  Skipped = "skipped",
}

export interface LineCoverage {
  lineNumber: number;
  hitCount: number | null;
  status: LineCoverageStatus;
  branches: BranchReport[];
}

class Branch {
  constructor(
    startLine: number,
    endLine: number,
    hitCount: number,
    inline: boolean,
    type: string
  ) {
    this.startLine = startLine;
    this.endLine = endLine;
    this.hitCount = hitCount;
    this.inline = inline;
    this.type = type;

    if (inline) {
      this.reportLine = startLine;
    } else {
      this.reportLine = startLine - 1;
    }

    if (hitCount > 0) {
      this.status = LineCoverageStatus.Covered;
    } else {
      this.status = LineCoverageStatus.Uncovered;
    }
  }
}

export class SourceFile {
  _branches: Branch[];
  _branchesReport: BranchesReport;

  constructor(fileName: string, coverage: Coverage) {
    this.fileName = fileName;
    this._branches = this._branchesFromCoverage(coverage);
    this._branchesReport = this._branchesReportFromBranches(this._branches);
    this.lines = this._linesFromCoverage(coverage);
    this.coverageStatistics = this._coverageStatisticsFromCoverage();
  }

  _coverageStatisticsFromCoverage(): CoverageStatistics {
    const coveredLines = this.lines.filter(
      (line) => line.status === LineCoverageStatus.Covered
    ).length;
    const uncoveredLines = this.lines.filter(
      (line) => line.status === LineCoverageStatus.Uncovered
    ).length;
    const totalStrength = this.lines.reduce((partialSum, line) => {
      const hitCount = line.hitCount ?? 0;
      return partialSum + hitCount;
    }, 0);
    const totalLines = coveredLines + uncoveredLines;
    let strength = 0.0;
    if (totalLines > 0) {
      strength = totalStrength / totalLines;
    }
    let percentage = 0.0;

    if (uncoveredLines === 0) {
      percentage = 100.0;
    } else {
      percentage = (coveredLines * 100) / totalLines;
    }

    return {
      totalLines,
      coveredLines,
      uncoveredLines,
      strength,
      percentage,
    };
  }

  _linesFromCoverage(coverage: Coverage): LineCoverage[] {
    const lines: LineCoverage[] = [];

    for (const [index, hitCount] of coverage.lines.entries()) {
      const lineNumber = index + 1;
      let status = LineCoverageStatus.Uncovered;
      const branches = this._branchesReport[lineNumber] ?? [];
      const lineHasUncoveredBranch = branches.some(
        (branch) => branch.hitCount <= 0
      );

      // This deviates from how Simplvecov does it, but believe it's more accurate.
      // If we're going to declare a line as uncovered, it should not be countered in the statistics.
      if (lineHasUncoveredBranch) {
        status = LineCoverageStatus.Uncovered;
      } else if (hitCount === null) {
        status = LineCoverageStatus.Never;
      } else if (hitCount > 0) {
        status = LineCoverageStatus.Covered;
      }

      lines.push({
        lineNumber,
        hitCount,
        status,
        branches,
      });
    }

    return lines;
  }

  _branchesFromCoverage(coverage: Coverage): Branch[] {
    const branches: Branch[] = [];
    const iterator = Object.entries(coverage.branches);

    for (const [condition, coverageBranches] of iterator) {
      const [_conditionType, _conditionID, conditionStartLine] =
        parseBranchLocation(condition);

      for (const [branchData, hitCount] of Object.entries(coverageBranches)) {
        const [type, _id, startLine, _startCol, endLine, _endCol] =
          parseBranchLocation(branchData);
        const inline = startLine === conditionStartLine;

        const branch = new Branch(
          startLine as number,
          endLine as number,
          hitCount,
          inline,
          type as string
        );

        branches.push(branch);
      }
    }

    return branches;
  }

  _branchesReportFromBranches(branches: Branch[]): BranchesReport {
    const branchesReport: BranchesReport = {};

    for (const { type, hitCount, reportLine } of branches) {
      if (!branchesReport[reportLine]) {
        branchesReport[reportLine] = [];
      }

      branchesReport[reportLine]!.push({ type, hitCount });
    }

    return branchesReport;
  }
}

export class ResultMerger {
  static combine(
    coverageA: Coverage | null,
    coverageB: Coverage | null
  ): Coverage {
    const combinedCoverage: Coverage = {
      lines: [],
      branches: {},
    };
    if (coverageA === null || coverageB === null) {
      if (coverageA) {
        return coverageA;
      }

      return coverageB ?? combinedCoverage;
    }

    combinedCoverage.lines = this.mergeLines(coverageA.lines, coverageB.lines);
    combinedCoverage.branches = this.mergeBranches(
      coverageA.branches,
      coverageB.branches
    );

    return combinedCoverage;
  }

  static merge(coverageFile: CoverageFile): FileCoverage {
    const fileCoverage: FileCoverage = {};
    for (const [_command, { coverage }] of Object.entries(coverageFile)) {
      for (const [fileName, coverageData] of Object.entries(coverage)) {
        if (!fileCoverage[fileName]) {
          fileCoverage[fileName] = coverageData;
        } else {
          fileCoverage[fileName] = this.combine(
            fileCoverage[fileName],
            coverageData
          );
        }
      }
    }

    return fileCoverage;
  }

  static mergeLines(
    coverageA: CoverageFileLine[],
    coverageB: CoverageFileLine[]
  ): CoverageFileLine[] {
    const lines = [];
    const maxLength = Math.max(coverageA.length, coverageB.length);
    for (let i = 0; i < maxLength; i++) {
      const lineA = coverageA[i];
      const lineB = coverageB[i];
      const sum = (lineA ?? 0) + (lineB ?? 0);

      // Logic:
      //
      // => null + 0 = null
      // => null + null = null
      // => int + int = int
      if (sum <= 0 && (lineA === null || lineB === null)) {
        lines.push(null);
      } else {
        lines.push(sum);
      }
    }

    return lines;
  }

  static mergeBranches(
    coverageA: BranchData,
    coverageB: BranchData
  ): BranchData {
    let merged = { ...coverageA };

    for (const [condition, branchesInsideB] of Object.entries(coverageB)) {
      if (!merged[condition]) {
        merged[condition] = branchesInsideB;
      } else {
        let branchesInsideA = merged[condition];
        let mergedBranches = { ...branchesInsideA };

        for (const [branch, bCount] of Object.entries(branchesInsideB)) {
          mergedBranches[branch] = (mergedBranches[branch] || 0) + bCount;
        }

        merged[condition] = mergedBranches;
      }
    }

    return merged;
  }
}

function parseBranchLocation(input: string): (number | string)[] {
  const trimmed = input.substring(2, input.length - 1);
  const parts = trimmed.split(",");

  return parts.map((element) => {
    element = element.trim();

    return isNaN(element as any) ? element : parseInt(element);
  });
}
