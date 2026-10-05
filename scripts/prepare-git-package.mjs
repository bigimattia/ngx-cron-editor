#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCliPath = process.env.npm_execpath;
const initialWorkingDirectory = process.env.INIT_CWD && resolve(process.env.INIT_CWD);

function isInsideRepo(path) {
  if (!path) {
    return false;
  }
  const relativePath = relative(repoRoot, path);
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

if (isInsideRepo(initialWorkingDirectory)) {
  console.log('Skipping Git package preparation in the source workspace.');
  process.exit(0);
}

if (!npmCliPath) {
  throw new Error('Git package preparation must be run by npm.');
}

const tempRoot = mkdtempSync(join(tmpdir(), 'ngx-cron-editor-git-package-'));

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, commandArgs, cwd, env = process.env, capture = false) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    env,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed with exit code ${result.status}`);
  }
  return capture ? result.stdout.trim() : undefined;
}

function runNpm(commandArgs, cwd, env = process.env, capture = false) {
  return run(process.execPath, [npmCliPath, ...commandArgs], cwd, env, capture);
}

function nodeExecutable(version) {
  const npmMajor = Number(runNpm(['--version'], repoRoot, process.env, true).split('.')[0]);
  const allowScripts = npmMajor >= 11 ? ['--allow-scripts=node'] : [];
  const executable = runNpm([
    'exec',
    '--yes',
    ...allowScripts,
    '--package',
    `node@${version}`,
    '--',
    'node',
    '-p',
    'process.execPath',
  ], repoRoot, process.env, true);
  if (!existsSync(executable)) {
    throw new Error(`npm did not provide the Node.js ${version} executable (reported ${executable}).`);
  }
  const actualVersion = run(executable, ['--version'], repoRoot, process.env, true);
  if (actualVersion !== `v${version}`) {
    throw new Error(`Expected Node.js ${version}, but npm provided ${actualVersion}.`);
  }
  return executable;
}

function collectFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const sourcePath = join(directory, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      return collectFiles(sourcePath, relativePath);
    }
    return entry.isFile() && entry.name !== 'package.json' ? [relativePath] : [];
  });
}

try {
  console.log('Building the Git dependency with Angular 15 for Angular 15–22 consumers.');

  const nodePath = nodeExecutable('18.20.8');
  const env = {
    ...process.env,
    PATH: `${dirname(nodePath)}${delimiter}${process.env.PATH ?? ''}`,
  };
  const fixtureDependencies = {
    '@angular/animations': '^15.0.0',
    '@angular/cdk': '^15.0.0',
    '@angular/common': '^15.0.0',
    '@angular/compiler': '^15.0.0',
    '@angular/compiler-cli': '^15.0.0',
    '@angular/core': '^15.0.0',
    '@angular/forms': '^15.0.0',
    '@angular/localize': '^15.0.0',
    '@angular/material': '^15.0.0',
    '@angular/platform-browser': '^15.0.0',
    '@angular/platform-browser-dynamic': '^15.0.0',
    'ng-packagr': '^15.0.0',
    rxjs: '^7.8.0',
    sass: '^1.83.0',
    tslib: '^2.3.0',
    typescript: '4.8.4',
  };
  writeJson(join(tempRoot, 'package.json'), {
    name: 'ngx-cron-editor-git-prepare',
    private: true,
    dependencies: fixtureDependencies,
  });

  const libraryRoot = join(tempRoot, 'library');
  mkdirSync(libraryRoot, { recursive: true });
  cpSync(join(repoRoot, 'libs/ngx-cron-editor/src'), join(libraryRoot, 'src'), { recursive: true });
  cpSync(join(repoRoot, 'libs/ngx-cron-editor/public_api.ts'), join(libraryRoot, 'public_api.ts'));
  cpSync(join(repoRoot, 'libs/ngx-cron-editor/package.json'), join(libraryRoot, 'package.json'));

  writeJson(join(libraryRoot, 'tsconfig.compat.json'), {
    compilerOptions: {
      baseUrl: '.',
      declaration: true,
      declarationMap: false,
      experimentalDecorators: true,
      importHelpers: true,
      lib: ['ES2022', 'dom'],
      module: 'ES2022',
      moduleResolution: 'node',
      skipLibCheck: true,
      sourceMap: true,
      strict: false,
      target: 'ES2022',
      types: ['@angular/localize'],
      useDefineForClassFields: false,
    },
    angularCompilerOptions: {
      compilationMode: 'partial',
      enableI18nLegacyMessageIdFormat: false,
      strictInjectionParameters: true,
      strictInputAccessModifiers: true,
      strictTemplates: true,
    },
  });

  writeJson(join(libraryRoot, 'ng-package.json'), {
    dest: '../dist/ngx-cron-editor',
    lib: {
      entryFile: './public_api.ts',
    },
    assets: ['./src/*.scss'],
  });

  runNpm([
    'install',
    '--no-save',
    '--package-lock=false',
    '--no-audit',
    '--no-fund',
  ], tempRoot, env);

  runNpm([
    'exec',
    '--',
    'ng-packagr',
    '-p',
    join(libraryRoot, 'ng-package.json'),
    '-c',
    join(libraryRoot, 'tsconfig.compat.json'),
  ], tempRoot, env);

  const packageOutput = join(tempRoot, 'dist/ngx-cron-editor');
  const packageManifestPath = join(packageOutput, 'package.json');
  if (!existsSync(packageManifestPath)) {
    throw new Error(`Angular 15 package output was not found at ${packageOutput}.`);
  }

  const packageManifest = JSON.parse(readFileSync(packageManifestPath, 'utf8'));
  const expectedPeerRange = '>=15.0.0 <23.0.0';
  for (const peer of ['@angular/common', '@angular/core', '@angular/forms', '@angular/material', '@angular/cdk']) {
    if (packageManifest.peerDependencies[peer] !== expectedPeerRange) {
      throw new Error(`${peer} must declare the verified range ${expectedPeerRange}.`);
    }
  }

  for (const entry of readdirSync(packageOutput, { withFileTypes: true })) {
    if (entry.name === 'package.json') {
      continue;
    }
    cpSync(join(packageOutput, entry.name), join(repoRoot, entry.name), { recursive: true });
  }

  packageManifest.files = collectFiles(packageOutput).sort();
  writeJson(join(repoRoot, 'package.json'), packageManifest);
  console.log(`Prepared ${packageManifest.name}@${packageManifest.version} for npm's Git install.`);
} catch (error) {
  console.error(`Git package preparation failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
