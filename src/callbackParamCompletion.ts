//THE PLAN:
//Find tables used to refer to functions in callback functions and sort them by frequency of use
//
//Figure out suggestion moment:
//Last parameter (after ',') of function with the word 'callback' in it, regardless of capitalization. ALSO dont suggest after a ')'
//If this is too problematic, bind it to a "custom callback functions" option, that can be turned off in order to opt in to just a hardcoded check (AddCallback and AddPriorityCallback)
//
//Based on Callback used, add params to suggestion string
//
//Once we hit the suggestion moment suggest all off these options:
//1. inline function | function(_, params)
//2. local function above callback (with cursor snapping to function name) | local function _cursor(_, params)
//3. same as above except its attached to a table (do this for all tables that are detected to be used 4 callbacks in order of most to least used) | function table:_cursor(params)
// For this ^^^ make sure _cursor is both in the function position and also in the func registration position in AddCallback()
// allow the user to change the order of these, along with multiple table sorting (default is most frequently used first), or disable some of these if they wish.

import * as vscode from 'vscode';
import { getConfig } from './config';
import { Constants } from './constants';
import * as luaparse from 'luaparse';

export function walk(node: unknown, visitor: (node: luaparse.Node) => boolean | void): void {
  if (!node || typeof node !== 'object') {return;}
  
  if ('type' in node && typeof node.type === 'string') {
    if (visitor(node as luaparse.Node) === false) {return;}
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      value.forEach(item => walk(item, visitor));
    } else if (value && typeof value === 'object' && 'type' in value) {
      walk(value, visitor);
    }
  }
}

interface CallbackArg {
    type: string;
    name?: string; //we should get the rgon callback json to a point where the question mark can be removed, since it means there are unnamed arguments out there!
}

interface CallbackReturn {
    type: string;
    optional?: boolean;
}

interface IsaacCallback {
    value?: string | number;
    args?: CallbackArg[];
    returns?: CallbackReturn[];
    param?: {
        type: string;
        name?: string;
        optional?: boolean;
    };
    comment?: string;
}

type Callbacks = Record<string, IsaacCallback>;

import * as jsonVanillaCallbacks from "./docs/enums/callbacks/vanilla.json";
import * as jsonRgonCallbacks from "./docs/enums/callbacks/repentogon.json";
import * as jsonStageApiCallbacks from "./docs/enums/callbacks/stageapi.json";

const config = getConfig();

const vanillaCallbacks: Callbacks = jsonVanillaCallbacks;
const rgonCallbacks: Callbacks = jsonRgonCallbacks;
const stageApiCallbacks: Callbacks = jsonStageApiCallbacks;
const callbackTables: Callbacks[] = [];

if(config.repentogonEnabled){callbackTables.push(rgonCallbacks);} //load before vanilla callbacks so that rgon vanilla overrides take priority
callbackTables.push(vanillaCallbacks);
if(config.stageAPISupportEnabled){callbackTables.push(stageApiCallbacks);}

var callbackByValue = new Map<number, IsaacCallback>();

for (var callbacks of callbackTables) {
    for (var callbackId in callbacks) {
        const entry = callbacks[callbackId];
        if (entry.value !== undefined) {
            const numericValue = typeof entry.value === "string" ? parseInt(entry.value, 10) : entry.value;
            if (!isNaN(numericValue) && callbackByValue.get(numericValue) === undefined) {
                callbackByValue.set(numericValue, entry);
            }
        }
    }
}

function findCallback(callbackId: string | number): IsaacCallback | undefined {
    if (typeof callbackId === "string") {
        for (var callbacks of callbackTables) {
            if (callbacks[callbackId] !== undefined) {
                return callbacks[callbackId];
            }
        }
    } else if (typeof callbackId === "number") {
        return callbackByValue.get(callbackId);
    }

    return undefined;
}

interface RegisterFuncConfig {
    idArg: number; //where you define da callback
    funcArg: number; //where you define da function
    hasModArg: boolean;
}

/* eslint-disable @typescript-eslint/naming-convention */
const REGISTER_FUNCTIONS: Record<string, RegisterFuncConfig> = {
    "AddCallback": { idArg: 0, funcArg: 1, hasModArg: true },
    "AddPriorityCallback": { idArg: 0, funcArg: 2, hasModArg: true },
    "StageAPI.AddCallback": { idArg: 1, funcArg: 3, hasModArg: false },
};
/* eslint-enable @typescript-eslint/naming-convention */

function getCallbackTablesFromLua(ast: luaparse.Chunk): string[]{
    const tableCounts: Record<string, number> = {};

    walk(ast, (node) => {
        if(node.type === "FunctionDeclaration"){
            if(node.identifier && node.identifier.type === "MemberExpression"){
                if(node.identifier.base.type === "Identifier"){
                    const base = node.identifier.base.name;
                    const funcName = node.identifier.identifier.name;

                    if (!REGISTER_FUNCTIONS[funcName] && node.identifier.indexer === ":") {
                        tableCounts[base] = (tableCounts[base] ?? 0) + 1;
                    }
                }
            }
        }
    });

    return Object.keys(tableCounts).sort((a, b) => tableCounts[b] - tableCounts[a]);
}

function getFuncNameFromCallback(callbackName: string): string{
    const words = callbackName.split("_");

    //am i even a good programmer at this point...
    var funcName = "";
    if (words[1] === "PRE"){
        funcName += "pre";
        words.map((word, idx) => {
            if (idx > 1){
                funcName += word.charAt(0) + word.substring(1).toLowerCase();
            }
        });
    } else if (words[1] === "POST") {
        funcName += "on";
        words.map((word, idx) => {
            if (idx > 1){
                funcName += word.charAt(0) + word.substring(1).toLowerCase();
            }
        });
    } else {
        funcName += "on";
        words.map((word, idx) => {
            if (idx > 0){
                funcName += word.charAt(0) + word.substring(1).toLowerCase();
            }
        });
    }

    return funcName;
}

function getCalleePath(node: luaparse.Expression): string | undefined {
    if (node.type === 'Identifier') {
        return node.name;
    }
    if (node.type === 'MemberExpression') {
        const base = getCalleePath(node.base);
        const key = node.identifier.name;
        if (!base || !key) {return undefined;}
        return `${base}${node.indexer}${key}`;
    }
    return undefined;
}

function getRegisterConfig(callExpr: luaparse.CallExpression): { cfg: RegisterFuncConfig; offset: number } | undefined {
    const fullPath = getCalleePath(callExpr.base);
    var cfg = fullPath ? REGISTER_FUNCTIONS[fullPath] : undefined;

    var name = "";
    var isColonCall = false;

    if (callExpr.base.type === 'MemberExpression') {
        name = callExpr.base.identifier.name;
        isColonCall = callExpr.base.indexer === ':';
    } else if (callExpr.base.type === 'Identifier') {
        name = callExpr.base.name;
    }

    if (!cfg) {
        cfg = REGISTER_FUNCTIONS[name];
    }

    if (!cfg) {return undefined;}

    const offset = (!isColonCall && callExpr.base.type === 'MemberExpression' && cfg.hasModArg) ? 1 : 0;

    return { cfg, offset };
}

vscode.commands.registerCommand(`${Constants.EXT_ID}.deleteLineXBack`, async (backAmount: number, text: string, funcName: string) => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {return;}

  const targetLine = Math.max(0, editor.selection.active.line - backAmount);
  const line = editor.document.lineAt(targetLine);

  await editor.edit(editBuilder => {
    editBuilder.delete(line.rangeIncludingLineBreak);
  });

  const lines = text.split('\n');
  const selections: vscode.Selection[] = [];
  lines.forEach((line, idx) => {
    if (line.includes(funcName) && idx > 0){ //skip first iteration cuz thats actually the inline string that gets deleted, also we substract by one cuz we removed a line earlier
        const start = new vscode.Position(targetLine + idx - 1, line.indexOf(funcName));
        const end = new vscode.Position(targetLine + idx - 1, line.indexOf(funcName) + funcName.length);

        selections.push(new vscode.Selection(start, end));
    }
  });

  editor.selections = selections;
});

interface CompletionPair {
    inlineString: string; //these have a space by default and no ',' as that is the trigger point for the autocomplete.
    bodyString: string;
    isColonMethod: boolean;
}

export function inlineParamCompletion(context: vscode.ExtensionContext) {
    console.log("callback param inline autocomplete enabled!");

    const provider : vscode.InlineCompletionItemProvider = {
        provideInlineCompletionItems(document, position, context, token) {
            const lineText = document.lineAt(position.line).text;
            const beforeCursor = lineText.slice(0, position.character);

            //Step 1: Find the suggestion moment.
            if(!beforeCursor.trimEnd().endsWith(',')) {return[];}
            if (lineText.includes(')') && position.character > lineText.lastIndexOf(')')) {return [];}

            const luaLineCode = beforeCursor + "nil)";
            var lineAST = luaparse.parse(luaLineCode, {wait: false});
            const statement = lineAST.body[0];
            if (!statement || statement.type !== 'CallStatement') {return [];}
            
            const callExpr = statement.expression;
            if (callExpr.type !== 'CallExpression') {return [];}

            const match = getRegisterConfig(callExpr);
            if(!match){return[];} 
            const funcIndex = match.cfg.funcArg + match.offset;
            const idIndex = match.cfg.idArg + match.offset;

            if((callExpr.arguments.length - 1) !== funcIndex) {return[];}

            var callbackName: string | number | undefined = undefined;
            const idArg = callExpr.arguments[idIndex];
            if (idArg.type === "MemberExpression"){
                callbackName = idArg.identifier.name;
            } else if (idArg.type === "NumericLiteral"){
                callbackName = idArg.value;
            } else if (idArg.type === "StringLiteral"){
                callbackName = idArg.raw.substring(1, idArg.raw.length-1);
            }
            if (callbackName === undefined) {return[];}

            //Step 2: Get the function name from callback used, and insert it into inline suggestions
            const allLuaCode = document.getText(new vscode.Range(new vscode.Position(0, 0), new vscode.Position(position.line-1, 0)));
            var allAST = luaparse.parse(allLuaCode, {wait: false});
            const sortedTables = getCallbackTablesFromLua(allAST);

            const funcName = typeof callbackName === "string" ? getFuncNameFromCallback(callbackName) : "placeholder";

            const completionPairs: CompletionPair[] = [
                {
                    inlineString: " function()\n\nend",
                    bodyString: "",
                    isColonMethod: false
                },
                {
                    inlineString: ` ${funcName}`,
                    bodyString: `local function ${funcName}()\n\nend`,
                    isColonMethod: false
                }
            ];

            sortedTables.forEach(tableName => {
                completionPairs.push({
                    inlineString: ` ${tableName}.${funcName}`,
                    bodyString: `function ${tableName}:${funcName}()\n\nend`,
                    isColonMethod: true
                });
            });

            //Step 3: Add params based on callback used
            var hasModRefParam = match.cfg.hasModArg;
            var callback = findCallback(callbackName);
            
            var callbackParams: string[] = [];
            if(callback !== undefined && callback.args !== undefined){
                callbackParams = callback.args.map((arg, idx) => {
                    const name = arg.name || `unkownArg${idx + 1}`;

                    if(name === name.toUpperCase()){
                        return name.toLowerCase();
                    } else {
                        return name.charAt(0).toLowerCase() + name.slice(1);
                    }
                });
            }

            const finalCompletionItems: vscode.InlineCompletionItem[] = [];
            
            completionPairs.map((pair) => {
                var inlineStr = pair.inlineString;
                var bodyStr = pair.bodyString;

                var paramsList = [...callbackParams];

                //prolly will be coming back to this condition later since it kinda irks me
                if (hasModRefParam && !pair.isColonMethod) {
                    paramsList.unshift("_");
                }

                const paramString = paramsList.join(", ");

                inlineStr = inlineStr.replace("()", `(${paramString})`);
                bodyStr = bodyStr.replace("()", `(${paramString})`);

                if (!lineText.trim().endsWith(')')) { inlineStr += ')'; }
                if (beforeCursor.endsWith(' ')) { inlineStr = inlineStr.substring(1); }

                const indent = beforeCursor.match(/^\s*/)?.[0] || "";
                if (!inlineStr.includes('(')) {
                    const indentedBody = bodyStr.split('\n').map(line => indent + line).join('\n');
                    
                    var finalLineText = lineText;
                    if (lineText.trimEnd().endsWith(')')) { finalLineText = lineText.slice(0, -1); }
                    const replacementText = `${inlineStr}\n${indentedBody}\n${finalLineText + inlineStr}`;
                    
                    const completionItem = new vscode.InlineCompletionItem(
                        replacementText,
                        new vscode.Range(position, position)
                    );

                    completionItem.command = {
                        title: "Delete Line",
                        command: `${Constants.EXT_ID}.deleteLineXBack`,
                        arguments: [bodyStr.split('\n').length + 1, replacementText, funcName]
                    };

                    finalCompletionItems.push(completionItem);
                } else {
                    const indentedInline = inlineStr.split('\n').map(line => line.includes("end") ? indent + line : line).join('\n');

                    finalCompletionItems.push(
                        new vscode.InlineCompletionItem(
                            indentedInline,
                            new vscode.Range(position, position)
                        )
                    );
                }
            });

            return finalCompletionItems;
        }
    };

    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider(
            {language: "lua"},
            provider
        )
    );
}