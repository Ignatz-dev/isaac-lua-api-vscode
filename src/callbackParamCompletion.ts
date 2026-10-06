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
import * as luaparse from 'luaparse';

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
    
//these have a space by default and no ',' as that is the trigger point for the autocomplete.
const INLINE_COMPLETION_STRINGS: string[] = [
    " function()\n\nend",
    " hi",
    //todo: figure out how to handle multiple tables using just 2 strings (also putting their name into here)...
];

const BODY_COMPLETION_STRINGS: string[] = [
    "local function hi()\n\nend"
];

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

export function inlineParamCompletion(context: vscode.ExtensionContext) {
    console.log("callback param inline autocomplete enabled!");

    const provider : vscode.InlineCompletionItemProvider = {
        provideInlineCompletionItems(document, position, context, token) {
            const lineText = document.lineAt(position.line).text;
            const beforeCursor = lineText.slice(0, position.character);

            //Step 1: Find the suggestion moment.
            if(!beforeCursor.trimEnd().endsWith(',')) {return[];}
            if (lineText.includes(')') && position.character > lineText.lastIndexOf(')')) {return [];}

            const luaCode = beforeCursor + "nil)";
            var ast = luaparse.parse(luaCode, {wait: false});
            const statement = ast.body[0];
            if (!statement || statement.type !== 'CallStatement') { return []; }
            
            const callExpr = statement.expression;
            if (callExpr.type !== 'CallExpression') { return []; }

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

            //Step 2: Transform suggestion contents based on current line contents (only for inline)
            var finalCompletionStrings = INLINE_COMPLETION_STRINGS.map(startString => {
                if (!lineText.trim().endsWith(')')) {startString += ')';}
                if (beforeCursor.endsWith(' ')) {startString = startString.substring(1, startString.length);} //used substring cuz trimStart doesnt work here ¯\_(ツ)_/¯
                return startString;
            });

            var finalBodyStrings = BODY_COMPLETION_STRINGS;

            //Step 3: Add params based on callback used
            var hasModRefParam = match.cfg.hasModArg;
            var callback = findCallback(callbackName);
            
            if(callback !== undefined && callback.args !== undefined){
                var params = callback.args.map((arg, idx) => {
                    const name = arg.name || `unkownArg${idx + 1}`;

                    if(name === name.toUpperCase()){
                        return name.toLowerCase();
                    } else {
                        return name.charAt(0).toLowerCase() + name.slice(1);
                    }
                }).join(", ");

                if (hasModRefParam && params.length > 0) {params = "_, " + params;}
                
                finalCompletionStrings = finalCompletionStrings.map(finalString => finalString.replace("()", `(${params})`));
                finalBodyStrings = finalBodyStrings.map(finalString => finalString.replace("()", `(${params})`));
            }

            const finalCompletionItems: vscode.InlineCompletionItem[] = [];

            finalCompletionStrings.map(finalString => {
                if (!finalString.includes('(')) {
                    const bodyString = finalBodyStrings[0]; //this is a nono but for now its ok
                    
                    //conver this into a function down the line
                    const indent = beforeCursor.match(/^\s*/)?.[0] || "";
                    const indentedBody = bodyString.split('\n').map(line => line.length > 0 ? indent + line : line).join('\n');
                    
                    const replacementText = `${finalString}\n${indentedBody}\n${lineText + finalString}`;
                    
                    finalCompletionItems.push(
                        new vscode.InlineCompletionItem(
                            replacementText,
                            new vscode.Range(position, position)
                        )
                    );
                } else {
                    finalCompletionItems.push(
                        new vscode.InlineCompletionItem(
                            finalString,
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