#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';

const execAsync = promisify(exec);

// 서버 초기화
const server = new Server(
  {
    name: "codex-bridge-mcp-server",
    version: "1.0.0"
  },
  {
    capabilities: {
      tools: {},
      resources: {}
    }
  }
);

// Codex CLI가 설치되어 있는지 확인
async function checkCodexInstalled(): Promise<boolean> {
  try {
    await execAsync('codex --version');
    return true;
  } catch (error) {
    return false;
  }
}

// Codex CLI 인증 상태 확인
async function checkCodexAuth(): Promise<boolean> {
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const authPath = path.join(homeDir, '.codex', 'auth.json');
    return fs.existsSync(authPath);
  } catch (error) {
    return false;
  }
}

// 도구 목록 등록
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "codex_execute",
        description: "OpenAI Codex CLI를 사용해서 코딩 작업을 수행합니다",
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "Codex에게 전달할 프롬프트 또는 작업 설명"
            },
            mode: {
              type: "string",
              enum: ["interactive", "exec", "non-interactive"],
              description: "실행 모드 (interactive: 대화형, exec: 비대화형 실행, non-interactive: 자동 승인)",
              default: "exec"
            },
            working_directory: {
              type: "string",
              description: "작업할 디렉터리 경로 (선택사항)"
            },
            model: {
              type: "string",
              description: "사용할 모델 (예: gpt-4, o1-preview)",
              default: "gpt-4"
            },
            sandbox: {
              type: "string",
              enum: ["read-only", "workspace-write", "danger-full-access"],
              description: "샌드박스 모드",
              default: "workspace-write"
            }
          },
          required: ["prompt"]
        }
      },
      {
        name: "codex_status",
        description: "Codex CLI 설치 및 인증 상태를 확인합니다",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      },
      {
        name: "codex_login",
        description: "Codex CLI ChatGPT 로그인을 도와줍니다",
        inputSchema: {
          type: "object",
          properties: {
            headless: {
              type: "boolean",
              description: "헤드리스 환경에서 실행 중인지 여부",
              default: false
            }
          },
          additionalProperties: false
        }
      },
      {
        name: "codex_project_init",
        description: "현재 디렉터리에서 Codex 프로젝트를 초기화합니다",
        inputSchema: {
          type: "object",
          properties: {
            working_directory: {
              type: "string",
              description: "프로젝트 디렉터리 경로"
            }
          },
          additionalProperties: false
        }
      }
    ]
  };
});

// 도구 호출 처리
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "codex_execute":
        return await handleCodexExecute(args);
      case "codex_status":
        return await handleCodexStatus(args);
      case "codex_login":
        return await handleCodexLogin(args);
      case "codex_project_init":
        return await handleCodexProjectInit(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }
      ],
      isError: true
    };
  }
});

async function handleCodexExecute(args: any) {
  const { 
    prompt, 
    mode = "exec", 
    working_directory, 
    model = "gpt-4",
    sandbox = "workspace-write"
  } = args;

  // 인증 상태 확인
  const isAuthenticated = await checkCodexAuth();
  if (!isAuthenticated) {
    return {
      content: [
        {
          type: "text",
          text: "❌ Codex CLI가 인증되지 않았습니다. 먼저 'codex_login' 도구를 사용해서 ChatGPT 계정으로 로그인해주세요."
        }
      ],
      isError: true
    };
  }

  let command: string;
  const baseArgs = [`--model`, model, `--sandbox`, sandbox];

  switch (mode) {
    case "interactive":
      command = `codex ${baseArgs.join(' ')} "${prompt}"`;
      break;
    case "exec":
      command = `codex exec ${baseArgs.join(' ')} "${prompt}"`;
      break;
    case "non-interactive":
      command = `codex exec --ask-for-approval never ${baseArgs.join(' ')} "${prompt}"`;
      break;
    default:
      command = `codex exec ${baseArgs.join(' ')} "${prompt}"`;
  }

  try {
    const options = working_directory ? { cwd: working_directory } : {};
    const { stdout, stderr } = await execAsync(command, { 
      ...options,
      timeout: 300000, // 5분 타임아웃
      maxBuffer: 1024 * 1024 * 10 // 10MB 버퍼
    });

    let result = '';
    if (stdout) result += `📤 출력:\n${stdout}\n\n`;
    if (stderr) result += `⚠️ 경고/오류:\n${stderr}\n\n`;
    
    if (!result) result = "✅ Codex 작업이 완료되었습니다.";

    return {
      content: [
        {
          type: "text",
          text: result.trim()
        }
      ]
    };
  } catch (error: any) {
    let errorMessage = `Codex CLI 실행 중 오류가 발생했습니다:\n`;
    if (error.stdout) errorMessage += `출력: ${error.stdout}\n`;
    if (error.stderr) errorMessage += `오류: ${error.stderr}\n`;
    errorMessage += `상세: ${error.message}`;

    return {
      content: [
        {
          type: "text",
          text: errorMessage
        }
      ],
      isError: true
    };
  }
}

async function handleCodexStatus(args: any) {
  const isInstalled = await checkCodexInstalled();
  const isAuthenticated = await checkCodexAuth();

  let statusMessage = "🔍 Codex CLI 상태 확인:\n\n";
  
  if (isInstalled) {
    try {
      const { stdout } = await execAsync('codex --version');
      statusMessage += `✅ Codex CLI 설치됨: ${stdout.trim()}\n`;
    } catch (error) {
      statusMessage += `⚠️ Codex CLI 설치 확인 중 오류 발생\n`;
    }
  } else {
    statusMessage += `❌ Codex CLI가 설치되지 않음\n`;
    statusMessage += `설치 방법: npm install -g @openai/codex\n`;
  }

  if (isAuthenticated) {
    statusMessage += `✅ ChatGPT 계정으로 인증됨\n`;
    try {
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const authPath = path.join(homeDir, '.codex', 'auth.json');
      const stats = fs.statSync(authPath);
      statusMessage += `인증 파일 날짜: ${stats.mtime.toLocaleString()}\n`;
    } catch (error) {
      statusMessage += `인증 파일 정보를 읽을 수 없음\n`;
    }
  } else {
    statusMessage += `❌ 인증되지 않음\n`;
    statusMessage += `로그인 방법: codex_login 도구 사용\n`;
  }

  return {
    content: [
      {
        type: "text",
        text: statusMessage
      }
    ]
  };
}

async function handleCodexLogin(args: any) {
  const { headless = false } = args;

  const isInstalled = await checkCodexInstalled();
  if (!isInstalled) {
    return {
      content: [
        {
          type: "text",
          text: "❌ Codex CLI가 설치되지 않았습니다. 먼저 다음 명령어로 설치해주세요:\n\nnpm install -g @openai/codex\n또는\nbrew install codex"
        }
      ],
      isError: true
    };
  }

  let instructions = "🔐 Codex CLI ChatGPT 로그인 안내:\n\n";
  
  if (headless) {
    instructions += "헤드리스 환경에서 로그인하는 방법:\n";
    instructions += "1. 로컬 머신에서 SSH 터널링 설정:\n";
    instructions += "   ssh -L 1455:localhost:1455 <user>@<remote-host>\n\n";
    instructions += "2. SSH 세션에서 로그인 시작:\n";
    instructions += "   codex\n\n";
    instructions += "3. 'Sign in with ChatGPT' 선택\n";
    instructions += "4. 출력되는 localhost:1455 URL을 로컬 브라우저에서 열기\n";
    instructions += "5. ChatGPT Plus/Pro/Business 계정으로 로그인\n";
  } else {
    instructions += "일반적인 로그인 방법:\n";
    instructions += "1. 터미널에서 다음 명령어 실행:\n";
    instructions += "   codex\n\n";
    instructions += "2. 'Sign in with ChatGPT' 선택\n";
    instructions += "3. 브라우저가 자동으로 열리면 ChatGPT 계정으로 로그인\n";
    instructions += "4. Plus, Pro, Business, Edu, Enterprise 플랜이 필요합니다\n";
  }

  instructions += "\n💡 참고: 이미 로그인되어 있다면 ~/.codex/auth.json 파일이 존재합니다.";

  return {
    content: [
      {
        type: "text",
        text: instructions
      }
    ]
  };
}

async function handleCodexProjectInit(args: any) {
  const { working_directory } = args;
  
  const targetDir = working_directory || process.cwd();
  
  try {
    // 프로젝트 디렉터리 확인
    if (!fs.existsSync(targetDir)) {
      return {
        content: [
          {
            type: "text",
            text: `❌ 디렉터리가 존재하지 않습니다: ${targetDir}`
          }
        ],
        isError: true
      };
    }

    // Git 저장소 확인
    const gitDir = path.join(targetDir, '.git');
    const isGitRepo = fs.existsSync(gitDir);
    
    let initMessage = `📁 Codex 프로젝트 초기화: ${targetDir}\n\n`;
    
    if (isGitRepo) {
      initMessage += "✅ Git 저장소 감지됨 - workspace-write 모드 권장\n";
      initMessage += "Codex가 파일 작성 및 명령어 실행을 승인 후 수행할 수 있습니다.\n\n";
    } else {
      initMessage += "⚠️ Git 저장소가 아님 - read-only 모드 권장\n";
      initMessage += "Codex가 읽기 전용으로 작업하며 변경사항은 승인이 필요합니다.\n\n";
    }

    // AGENTS.md 파일 생성 제안
    const agentsFile = path.join(targetDir, 'AGENTS.md');
    if (!fs.existsSync(agentsFile)) {
      initMessage += "💡 AGENTS.md 파일을 생성하여 Codex에게 프로젝트별 지침을 제공할 수 있습니다.\n";
      initMessage += "예시 내용:\n";
      initMessage += "```markdown\n";
      initMessage += "# 프로젝트 지침\n\n";
      initMessage += "## 코딩 스타일\n";
      initMessage += "- TypeScript 사용\n";
      initMessage += "- ESLint 규칙 준수\n\n";
      initMessage += "## 테스트\n";
      initMessage += "- Jest 사용\n";
      initMessage += "- 모든 함수에 단위 테스트 작성\n";
      initMessage += "```\n\n";
    } else {
      initMessage += "✅ AGENTS.md 파일이 이미 존재합니다.\n\n";
    }

    initMessage += "🚀 이제 Claude Code에서 다음과 같이 Codex를 사용할 수 있습니다:\n";
    initMessage += `- codex_execute 도구로 "${targetDir}"에서 코딩 작업 수행\n`;
    initMessage += "- 자동으로 적절한 샌드박스 모드가 적용됩니다.";

    return {
      content: [
        {
          type: "text",
          text: initMessage
        }
      ]
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `❌ 프로젝트 초기화 중 오류 발생: ${error instanceof Error ? error.message : String(error)}`
        }
      ],
      isError: true
    };
  }
}

// 서버 시작
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Codex Bridge MCP Server running on stdio");
}

main().catch(console.error);