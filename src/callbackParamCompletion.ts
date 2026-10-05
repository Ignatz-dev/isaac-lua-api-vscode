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

interface CallbackArg {
    type: string;
    name?: string;
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
        optional: boolean;
    };
    comment?: string;
}

type Callbacks = Record<string, IsaacCallback>;

import * as jsonVanillaCallbacks from "./docs/enums/callbacks/vanilla.json";
import * as jsonRgonCallbacks from "./docs/enums/callbacks/repentogon.json";
import * as jsonStageApiCallbacks from "./docs/enums/callbacks/stageapi.json";

const vanillaCallbacks: Callbacks = jsonVanillaCallbacks;
const rgonCallbacks: Callbacks = jsonRgonCallbacks;
const stageApiCallbacks: Callbacks = jsonStageApiCallbacks;
const callbackTables = [
    rgonCallbacks, //load before vanilla callbacks so that rgon vanilla overrides take priority
    vanillaCallbacks,
    stageApiCallbacks
];

//if not RGON then pop rgonCallbacks from callbackTables here


var callbackByValue = new Map<number, IsaacCallback>();

for (var callbacks of callbackTables) {
    for (var callbackId in callbacks) {
        const entry = callbacks[callbackId];
        if (entry.value !== undefined) {
            const numericValue = typeof entry.value === "string" ? parseInt(entry.value, 10) : entry.value;
            if (!isNaN(numericValue)) {
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
const INLINE_FUNC_STRING = " function()\n\nend";

export function inlineParamCompletion(context: vscode.ExtensionContext) {
    console.log("callback param inline autocomplete enabled!");

    const provider : vscode.InlineCompletionItemProvider = {
        provideInlineCompletionItems(document, position, context, token) {
            const lineText = document.lineAt(position.line).text;
            const beforeCursor = lineText.slice(0, position.character);

            //Step 1: Find the suggestion moment.
            if (lineText.includes(')') && position.character > lineText.lastIndexOf(')')) {return [];}
            const functionName = lineText.substring(0, lineText.indexOf('(')).trim();
            const suggestionCondition = functionName.toLowerCase().includes('callback') && beforeCursor.trimEnd().endsWith(',');
            if (!suggestionCondition) {return [];}
            const paramCount = (beforeCursor.match(/,/g) || []).length;
            if (functionName.toLowerCase().includes("prioritycallback") && paramCount !== 2) {return [];} //suggest on 3rd param for prio callback
            //could easily add support for custom multi param callback registration functions here, just replace the func ur looking for and expected param number

            //Step 2: Transform suggestion contents based on current line contents
            var startString = INLINE_FUNC_STRING;
            if (!lineText.trim().endsWith(')')) {startString += ')';}
            if (beforeCursor.endsWith(' ')) {startString = startString.substring(1, startString.length);} //used substring cuz trimStart doesnt work here ¯\_(ツ)_/¯

            //Step 3: Add params based on callback used (lineText or beforeCursor here??)
            const firstParam = beforeCursor.substring(beforeCursor.indexOf('(') + 1, beforeCursor.indexOf(',')).trim();
            var callbackName = firstParam;
            if(firstParam.includes('.')) { //if is an enum and not a number
                callbackName = firstParam.substring(firstParam.indexOf('.') + 1);
            }

            var hasModRefParam = true;

            var callback = findCallback(callbackName);
            if(callback !== undefined && callback.args !== undefined){
                var params = callback.args.map((arg, idx) => {
                    const name = arg.name || `unkownArg${idx + 1}`;
                    return name.charAt(0).toLowerCase() + name.slice(1);
                }).join(", ");

                if (hasModRefParam) {params = "_, " + params;}
                
                startString = startString.replace("()", `(${params})`);
            }


            return[
                new vscode.InlineCompletionItem(
                    startString,
                    new vscode.Range(position, position)
                ),
                new vscode.InlineCompletionItem(
                    "hi",
                    new vscode.Range(position, position)
                )
            ];
        }
    };

    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider(
            {language: "lua"},
            provider
        )
    );
}