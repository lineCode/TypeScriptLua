import * as ts from 'typescript';
import { BinaryWriter } from './binarywriter';
import { FunctionContext, UpvalueInfo } from './contexts';
import { IdentifierResolver, ResolvedInfo, ResolvedKind } from './resolvers';
import { Ops, OpMode, OpCodes, LuaTypes } from './opcodes';
import { Helpers } from './helpers';

export class Emitter {
    public writer: BinaryWriter = new BinaryWriter();
    public fileModuleName: string;
    private functionContextStack: Array<FunctionContext> = [];
    private functionContext: FunctionContext;
    private resolver: IdentifierResolver;
    private sourceFileName: string;
    private opsMap = [];
    private extraDebugEmbed = false;

    public constructor(typeChecker: ts.TypeChecker, private options: ts.CompilerOptions, private cmdLineOptions: any) {
        this.resolver = new IdentifierResolver(typeChecker);
        this.functionContext = new FunctionContext();

        this.opsMap[ts.SyntaxKind.PlusToken] = Ops.ADD;
        this.opsMap[ts.SyntaxKind.MinusToken] = Ops.SUB;
        this.opsMap[ts.SyntaxKind.AsteriskToken] = Ops.MUL;
        this.opsMap[ts.SyntaxKind.PercentToken] = Ops.MOD;
        this.opsMap[ts.SyntaxKind.AsteriskAsteriskToken] = Ops.POW;
        this.opsMap[ts.SyntaxKind.SlashToken] = Ops.DIV;
        this.opsMap[ts.SyntaxKind.AmpersandToken] = Ops.BAND;
        this.opsMap[ts.SyntaxKind.BarToken] = Ops.BOR;
        this.opsMap[ts.SyntaxKind.CaretToken] = Ops.BXOR;
        this.opsMap[ts.SyntaxKind.LessThanLessThanToken] = Ops.SHL;
        this.opsMap[ts.SyntaxKind.GreaterThanGreaterThanToken] = Ops.SHR;
        this.opsMap[ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken] = Ops.SHR;
        this.opsMap[ts.SyntaxKind.EqualsEqualsToken] = Ops.EQ;
        this.opsMap[ts.SyntaxKind.EqualsEqualsEqualsToken] = Ops.EQ;
        this.opsMap[ts.SyntaxKind.LessThanToken] = Ops.LT;
        this.opsMap[ts.SyntaxKind.LessThanEqualsToken] = Ops.LE;
        this.opsMap[ts.SyntaxKind.ExclamationEqualsToken] = Ops.EQ;
        this.opsMap[ts.SyntaxKind.ExclamationEqualsEqualsToken] = Ops.EQ;
        this.opsMap[ts.SyntaxKind.GreaterThanToken] = Ops.LE;
        this.opsMap[ts.SyntaxKind.GreaterThanEqualsToken] = Ops.LT;

        this.opsMap[ts.SyntaxKind.PlusEqualsToken] = Ops.ADD;
        this.opsMap[ts.SyntaxKind.MinusEqualsToken] = Ops.SUB;
        this.opsMap[ts.SyntaxKind.AsteriskEqualsToken] = Ops.MUL;
        this.opsMap[ts.SyntaxKind.PercentEqualsToken] = Ops.MOD;
        this.opsMap[ts.SyntaxKind.AsteriskAsteriskEqualsToken] = Ops.POW;
        this.opsMap[ts.SyntaxKind.SlashEqualsToken] = Ops.DIV;
        this.opsMap[ts.SyntaxKind.AmpersandEqualsToken] = Ops.BAND;
        this.opsMap[ts.SyntaxKind.BarEqualsToken] = Ops.BOR;
        this.opsMap[ts.SyntaxKind.CaretEqualsToken] = Ops.BXOR;
        this.opsMap[ts.SyntaxKind.LessThanLessThanEqualsToken] = Ops.SHL;
        this.opsMap[ts.SyntaxKind.GreaterThanGreaterThanEqualsToken] = Ops.SHR;
        this.opsMap[ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken] = Ops.SHR;

        this.extraDebugEmbed = cmdLineOptions.extradebug ? true : false;
    }

    private lib = '                                                 \
    __instanceof = __instanceof || function(inst, type) {           \
        if (!inst) {                                                \
            return false;                                           \
        }                                                           \
                                                                    \
        let mt = inst.__index;                                      \
        while (mt) {                                                \
            if (mt == type) {                                       \
                return true;                                        \
            }                                                       \
                                                                    \
            mt = mt.__index;                                        \
        }                                                           \
                                                                    \
        return false;                                               \
    }                                                               \
                                                                    \
    __get_call__ = __get_call__ || function (t, k) {                \
        const getmethod = t.__proto.__get__[k];                     \
        if (getmethod) {                                            \
            return getmethod(t);                                    \
        }                                                           \
                                                                    \
        return rawget(t, k) || t.__proto[k];                        \
    }                                                               \
                                                                    \
    __set_call__ = __set_call__ || function (t, k, v) {             \
        const setmethod = t.__proto.__set__[k];                     \
        if (setmethod) {                                            \
            setmethod(t, v);                                        \
            return;                                                 \
        }                                                           \
                                                                    \
        rawset(t, k, v);                                            \
    }';

    /*
    -- new instance
    local a = {}
    --a.__index = proto
    a.__index = __get_call__
    a.__proto = proto
    a.__newindex = __set_call__

    setmetatable(a, a)
    */

    public processNode(node: ts.Node): void {
        switch (node.kind) {
            case ts.SyntaxKind.SourceFile: this.processFile(<ts.SourceFile>node); return;
            case ts.SyntaxKind.Bundle: this.processBundle(<ts.Bundle>node); return;
            case ts.SyntaxKind.UnparsedSource: this.processUnparsedSource(<ts.UnparsedSource>node); return;
        }

        // TODO: finish it
        throw new Error('Method not implemented.');
    }

    public save() {
        this.emitHeader();
        // f->sizeupvalues (byte)
        this.writer.writeByte(this.functionContext.upvalues.length);
        this.emitFunction(this.functionContext);
    }

    private pushFunctionContext(location: ts.Node) {
        const localFunctionContext = this.functionContext;
        this.functionContextStack.push(localFunctionContext);
        this.functionContext = new FunctionContext();
        this.functionContext.function_or_file_location_node = location;
        if (localFunctionContext) {
            this.functionContext.container = localFunctionContext;
            this.functionContext.current_location_node = localFunctionContext.current_location_node;
            this.functionContext.location_scopes = localFunctionContext.location_scopes;
        }
    }

    private popFunctionContext(): FunctionContext {
        const localFunctionContext = this.functionContext;
        this.functionContext = this.functionContextStack.pop();
        return localFunctionContext;
    }

    private processFunction(
        location: ts.Node,
        statements: ts.NodeArray<ts.Statement>,
        parameters: ts.NodeArray<ts.ParameterDeclaration>,
        createEnvironment?: boolean): FunctionContext {

        this.pushFunctionContext(location);
        this.processFunctionWithinContext(location, statements, parameters, createEnvironment);
        return this.popFunctionContext();
    }

    private hasMemberThis(location: ts.Node): boolean {
        if (!location) {
            return false;
        }

        if (location.parent && location.parent.kind !== ts.SyntaxKind.ClassDeclaration) {
            return false;
        }

        switch (location.kind) {
            case ts.SyntaxKind.MethodDeclaration:
                return true;
            case ts.SyntaxKind.PropertyDeclaration:
                return false;
        }

        return false;
    }

    private hasNodeUsedThis(location: ts.Node): boolean {
        let createThis = false;
        function checkThisKeyward(node: ts.Node): any {
            if (node.kind === ts.SyntaxKind.ThisKeyword) {
                createThis = true;
                return true;
            }

            ts.forEachChild(node, checkThisKeyward);
        }

        ts.forEachChild(location, checkThisKeyward);
        return createThis;
    }

    private processDebugInfo(nodeIn: ts.Node, functionContext: FunctionContext) {
        let node = nodeIn;
        let file = (<any>ts).getSourceFileOfNode(node);
        if (!file) {
            node = (<any>node).__origin;
            file = (<any>ts).getSourceFileOfNode(node);
            if (!file) {
                return;
            }
        }

        if (node.pos === -1) {
            return;
        }

        const locStart = (<any>ts).getLineAndCharacterOfPosition(file, node.pos);
        const locEnd = (<any>ts).getLineAndCharacterOfPosition(file, node.end);

        if (!functionContext.debug_location) {
            functionContext.debug_location = '@' + file.fileName;
        } else {
            functionContext.debug_location = '@' + this.fileModuleName + '.lua';
        }

        switch (node.kind) {
            case ts.SyntaxKind.FunctionDeclaration:
                functionContext.debug_location +=
                    ':' + ((<ts.FunctionDeclaration>node).name ? (<ts.FunctionDeclaration>node).name.text : 'noname');
                break;
            case ts.SyntaxKind.FunctionExpression:
                functionContext.debug_location +=
                    ':' + ((<ts.FunctionExpression>node).name ? (<ts.FunctionExpression>node).name.text : 'noname');
                break;
            case ts.SyntaxKind.ArrowFunction:
                functionContext.debug_location +=
                    ':' + ((<ts.FunctionExpression>node).name ? (<ts.FunctionExpression>node).name.text : 'arrow');
                break;
            case ts.SyntaxKind.TryStatement:
                functionContext.debug_location += ':try';
                break;
            case ts.SyntaxKind.Constructor:
                functionContext.debug_location += ':' + (<ts.ClassDeclaration>node.parent).name.text + ':ctor';
                break;
            case ts.SyntaxKind.MethodDeclaration:
                functionContext.debug_location +=
                    ':' + (<ts.ClassDeclaration>node.parent).name.text +
                    ':' + (<ts.Identifier>(<ts.MethodDeclaration>node).name).text;
                break;
            case ts.SyntaxKind.GetAccessor:
                functionContext.debug_location +=
                    ':' + (<ts.ClassDeclaration>node.parent).name.text +
                    ':' + (<ts.Identifier>(<ts.GetAccessorDeclaration>node).name).text + ':get';
                break;
            case ts.SyntaxKind.SetAccessor:
                functionContext.debug_location +=
                    ':' + (<ts.ClassDeclaration>node.parent).name.text +
                    ':' + (<ts.Identifier>(<ts.SetAccessorDeclaration>node).name).text + ':set';
                break;
            case ts.SyntaxKind.SourceFile:
                break;
            default:
                throw new Error('Not Implemented');
        }

        if (node.kind !== ts.SyntaxKind.SourceFile) {
            functionContext.linedefined = locStart.line + 1;
            functionContext.lastlinedefined = locEnd.line + 1;
        } else {
            functionContext.linedefined = 0;
            functionContext.lastlinedefined = 0;
        }
    }

    private processFunctionWithinContext(
        location: ts.Node,
        statements: ts.NodeArray<ts.Statement>,
        parameters: ts.NodeArray<ts.ParameterDeclaration>,
        createEnvironment?: boolean) {

        this.functionContext.newLocalScope((<any>location).__origin ? (<any>location).__origin : location);

        const isClassDeclaration = this.functionContext.container
            && this.functionContext.container.current_location_node
            && this.functionContext.container.current_location_node.kind === ts.SyntaxKind.ClassDeclaration;
        this.functionContext.thisInUpvalue =
            location.kind === ts.SyntaxKind.ArrowFunction && !isClassDeclaration || location.kind === ts.SyntaxKind.TryStatement;
        const isMethod = location.kind === ts.SyntaxKind.FunctionDeclaration
            || location.kind === ts.SyntaxKind.FunctionExpression
            || location.kind === ts.SyntaxKind.ArrowFunction
            || location.kind === ts.SyntaxKind.MethodDeclaration
            || location.kind === ts.SyntaxKind.Constructor
            || location.kind === ts.SyntaxKind.SetAccessor
            || location.kind === ts.SyntaxKind.GetAccessor;

        // debug info
        this.processDebugInfo(location, this.functionContext);

        if (createEnvironment) {
            this.resolver.createEnv(this.functionContext);

            // we need to inject helper functions
            this.processTSCode(this.lib, true);
        }

        const origin = (<ts.Node>(<any>location).__origin);
        if (isMethod && (origin || !this.functionContext.thisInUpvalue)) {
            const createThis = this.hasMemberThis(origin) || this.hasNodeUsedThis(location);
            if (createThis) {
                const thisIsInParams = parameters && parameters.some(p => (<ts.Identifier>p.name).text === 'this');
                if (!thisIsInParams) {
                    this.functionContext.createLocal('this');
                }
            }
        }

        if (parameters) {
            let dotDotDotAny = false;
            parameters.forEach(p => {
                this.functionContext.createLocal((<ts.Identifier>p.name).text);
                if (p.dotDotDotToken) {
                    dotDotDotAny = true;
                }
            });

            this.functionContext.numparams = parameters.length;
            this.functionContext.is_vararg = dotDotDotAny;
        }

        // select all parameters with default values
        if (parameters) {
            parameters
                .filter(p => p.initializer)
                .map(p => ts.createIf(
                    ts.createPrefix(ts.SyntaxKind.ExclamationToken, <ts.Identifier>p.name),
                    ts.createStatement(ts.createAssignment(<ts.Identifier>p.name, p.initializer))))
                .forEach(s => {
                    this.processStatement(s);
                });

            // we need to load all '...<>' into arrays
            parameters.filter(p => p.dotDotDotToken).forEach(p => {
                const localVar = this.functionContext.findLocal((<ts.Identifier>p.name).text);
                this.functionContext.code.push([Ops.NEWTABLE, localVar + 1, 0, 0]);
                this.functionContext.code.push([Ops.VARARG, localVar + 2, 0, 0]);
                this.functionContext.code.push([Ops.SETLIST, localVar + 1, 0, 1]);

                // workaround 0 element
                const zeroIndexInfo = this.resolver.returnConst(0, this.functionContext);
                this.functionContext.code.push(
                    [Ops.SETTABLE,
                    localVar + 1,
                    zeroIndexInfo.getRegisterOrIndex(),
                        localVar]);

                this.functionContext.code.push([
                    Ops.MOVE,
                    localVar,
                    localVar + 1
                ]);
            });
        }

        statements.forEach(s => {
            this.processStatement(s);
        });

        // add final 'RETURN'
        this.functionContext.code.push([Ops.RETURN, 0, 1]);

        this.functionContext.restoreLocalScope();

        if (this.functionContext.availableRegister !== 0) {
            throw new Error('stack is not cleaned up');
        }
    }

    private processFile(sourceFile: ts.SourceFile): void {

        this.functionContext.function_or_file_location_node = sourceFile;

        this.sourceFileName = sourceFile.fileName;
        this.processFunctionWithinContext(sourceFile, sourceFile.statements, <any>[], !this.functionContext.environmentCreated);
        this.functionContext.environmentCreated = true;
        this.functionContext.is_vararg = true;
    }

    private processBundle(bundle: ts.Bundle): void {
        throw new Error('Method not implemented.');
    }

    private processUnparsedSource(unparsedSource: ts.UnparsedSource): void {
        throw new Error('Method not implemented.');
    }

    private processStatement(node: ts.Statement): void {
        const stackSize = this.markStack();
        this.processStatementInternal(node);
        this.rollbackUnused(stackSize);
    }

    private processStatementInternal(node: ts.Statement): void {

        this.functionContext.code.setNodeToTrackDebugInfo(node);

        switch (node.kind) {
            case ts.SyntaxKind.EmptyStatement: return;
            case ts.SyntaxKind.VariableStatement: this.processVariableStatement(<ts.VariableStatement>node); return;
            case ts.SyntaxKind.FunctionDeclaration: this.processFunctionDeclaration(<ts.FunctionDeclaration>node); return;
            case ts.SyntaxKind.Block: this.processBlock(<ts.Block>node); return;
            case ts.SyntaxKind.ModuleBlock: this.processModuleBlock(<ts.ModuleBlock>node); return;
            case ts.SyntaxKind.ReturnStatement: this.processReturnStatement(<ts.ReturnStatement>node); return;
            case ts.SyntaxKind.IfStatement: this.processIfStatement(<ts.IfStatement>node); return;
            case ts.SyntaxKind.DoStatement: this.processDoStatement(<ts.DoStatement>node); return;
            case ts.SyntaxKind.WhileStatement: this.processWhileStatement(<ts.WhileStatement>node); return;
            case ts.SyntaxKind.ForStatement: this.processForStatement(<ts.ForStatement>node); return;
            case ts.SyntaxKind.ForInStatement: this.processForInStatement(<ts.ForInStatement>node); return;
            case ts.SyntaxKind.ForOfStatement: this.processForOfStatement(<ts.ForOfStatement>node); return;
            case ts.SyntaxKind.BreakStatement: this.processBreakStatement(<ts.BreakStatement>node); return;
            case ts.SyntaxKind.ContinueStatement: this.processContinueStatement(<ts.ContinueStatement>node); return;
            case ts.SyntaxKind.SwitchStatement: this.processSwitchStatement(<ts.SwitchStatement>node); return;
            case ts.SyntaxKind.ExpressionStatement: this.processExpressionStatement(<ts.ExpressionStatement>node); return;
            case ts.SyntaxKind.TryStatement: this.processTryStatement(<ts.TryStatement>node); return;
            case ts.SyntaxKind.ThrowStatement: this.processThrowStatement(<ts.ThrowStatement>node); return;
            case ts.SyntaxKind.DebuggerStatement: this.processDebuggerStatement(<ts.DebuggerStatement>node); return;
            case ts.SyntaxKind.EnumDeclaration: this.processEnumDeclaration(<ts.EnumDeclaration>node); return;
            case ts.SyntaxKind.ClassDeclaration: this.processClassDeclaration(<ts.ClassDeclaration>node); return;
            case ts.SyntaxKind.ExportDeclaration: this.processExportDeclaration(<ts.ExportDeclaration>node); return;
            case ts.SyntaxKind.ImportDeclaration: this.processImportDeclaration(<ts.ImportDeclaration>node); return;
            case ts.SyntaxKind.ModuleDeclaration: this.processModuleDeclaration(<ts.ModuleDeclaration>node); return;
            case ts.SyntaxKind.NamespaceExportDeclaration: this.processNamespaceDeclaration(<ts.NamespaceDeclaration>node); return;
            case ts.SyntaxKind.InterfaceDeclaration: /*nothing to do*/ return;
            case ts.SyntaxKind.TypeAliasDeclaration: /*nothing to do*/ return;
        }

        // TODO: finish it
        throw new Error('Method not implemented.');
    }

    private processExpression(node: ts.Expression): void {

        this.functionContext.code.setNodeToTrackDebugInfo(node);

        switch (node.kind) {
            case ts.SyntaxKind.NewExpression: this.processNewExpression(<ts.NewExpression>node); return;
            case ts.SyntaxKind.CallExpression: this.processCallExpression(<ts.CallExpression>node); return;
            case ts.SyntaxKind.PropertyAccessExpression: this.processPropertyAccessExpression(<ts.PropertyAccessExpression>node); return;
            case ts.SyntaxKind.PrefixUnaryExpression: this.processPrefixUnaryExpression(<ts.PrefixUnaryExpression>node); return;
            case ts.SyntaxKind.PostfixUnaryExpression: this.processPostfixUnaryExpression(<ts.PostfixUnaryExpression>node); return;
            case ts.SyntaxKind.BinaryExpression: this.processBinaryExpression(<ts.BinaryExpression>node); return;
            case ts.SyntaxKind.ConditionalExpression: this.processConditionalExpression(<ts.ConditionalExpression>node); return;
            case ts.SyntaxKind.DeleteExpression: this.processDeleteExpression(<ts.DeleteExpression>node); return;
            case ts.SyntaxKind.TypeOfExpression: this.processTypeOfExpression(<ts.TypeOfExpression>node); return;
            case ts.SyntaxKind.FunctionExpression: this.processFunctionExpression(<ts.FunctionExpression>node); return;
            case ts.SyntaxKind.ArrowFunction: this.processArrowFunction(<ts.ArrowFunction>node); return;
            case ts.SyntaxKind.ElementAccessExpression: this.processElementAccessExpression(<ts.ElementAccessExpression>node); return;
            case ts.SyntaxKind.ParenthesizedExpression: this.processParenthesizedExpression(<ts.ParenthesizedExpression>node); return;
            case ts.SyntaxKind.TypeAssertionExpression: this.processTypeAssertionExpression(<ts.TypeAssertion>node); return;
            case ts.SyntaxKind.VariableDeclarationList: this.processVariableDeclarationList(<ts.VariableDeclarationList><any>node); return;
            case ts.SyntaxKind.TrueKeyword:
            case ts.SyntaxKind.FalseKeyword: this.processBooleanLiteral(<ts.BooleanLiteral>node); return;
            case ts.SyntaxKind.NullKeyword: this.processNullLiteral(<ts.NullLiteral>node); return;
            case ts.SyntaxKind.NumericLiteral: this.processNumericLiteral(<ts.NumericLiteral>node); return;
            case ts.SyntaxKind.StringLiteral: this.processStringLiteral(<ts.StringLiteral>node); return;
            case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
                this.processNoSubstitutionTemplateLiteral(<ts.NoSubstitutionTemplateLiteral>node); return;
            case ts.SyntaxKind.ObjectLiteralExpression: this.processObjectLiteralExpression(<ts.ObjectLiteralExpression>node); return;
            case ts.SyntaxKind.TemplateExpression: this.processTemplateExpression(<ts.TemplateExpression>node); return;
            case ts.SyntaxKind.ArrayLiteralExpression: this.processArrayLiteralExpression(<ts.ArrayLiteralExpression>node); return;
            case ts.SyntaxKind.RegularExpressionLiteral: this.processRegularExpressionLiteral(<ts.RegularExpressionLiteral>node); return;
            case ts.SyntaxKind.ThisKeyword: this.processThisExpression(<ts.ThisExpression>node); return;
            case ts.SyntaxKind.SuperKeyword: this.processSuperExpression(<ts.SuperExpression>node); return;
            case ts.SyntaxKind.VoidExpression: this.processVoidExpression(<ts.VoidExpression>node); return;
            case ts.SyntaxKind.NonNullExpression: this.processNonNullExpression(<ts.NonNullExpression>node); return;
            case ts.SyntaxKind.AsExpression: this.processAsExpression(<ts.AsExpression>node); return;
            case ts.SyntaxKind.SpreadElement: this.processSpreadElement(<ts.SpreadElement>node); return;
            case ts.SyntaxKind.Identifier: this.processIndentifier(<ts.Identifier>node); return;
        }

        // TODO: finish it
        throw new Error('Method not implemented.');
    }

    private processExpressionStatement(node: ts.ExpressionStatement): void {
        this.processExpression(node.expression);
    }

    private transpileTSNode(node: ts.Node, transformText?: (string) => string) {
        return this.transpileTSCode(node.getFullText(), transformText);
    }

    private transpileTSCode(code: string, transformText?: (string) => string) {

        const opts = {
            module: ts.ModuleKind.CommonJS,
            alwaysStrict: false,
            noImplicitUseStrict: true,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            target: ts.ScriptTarget.ES5
        };

        const result = ts.transpileModule(code, { compilerOptions: opts });

        let jsText = result.outputText;
        if (transformText) {
            jsText = transformText(jsText);
        }

        return this.parseJSCode(jsText);
    }

    private parseTSCode(jsText: string) {

        const opts = {
            module: ts.ModuleKind.CommonJS,
            alwaysStrict: false,
            noImplicitUseStrict: true,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            target: ts.ScriptTarget.ES5
        };

        const sourceFile = ts.createSourceFile(
            this.sourceFileName, jsText, ts.ScriptTarget.ES5, /*setParentNodes */ true, ts.ScriptKind.TS);
        // nneded to make typeChecker to work properly
        (<any>ts).bindSourceFile(sourceFile, opts);
        return sourceFile.statements;
    }

    private bind(node: ts.Statement) {

        const opts = {
            module: ts.ModuleKind.CommonJS,
            alwaysStrict: false,
            noImplicitUseStrict: true,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            target: ts.ScriptTarget.ES5
        };

        const sourceFile = ts.createSourceFile(
            this.sourceFileName, '', ts.ScriptTarget.ES5, /*setParentNodes */ true, ts.ScriptKind.TS);

        (<any>sourceFile.statements) = [node];

        (<any>ts).bindSourceFile(sourceFile, opts);
        return sourceFile.statements;
    }

    private parseJSCode(jsText: string) {

        const opts = {
            module: ts.ModuleKind.CommonJS,
            alwaysStrict: false,
            noImplicitUseStrict: true,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            target: ts.ScriptTarget.ES5
        };

        const sourceFile = ts.createSourceFile('partial', jsText, ts.ScriptTarget.ES5, /*setParentNodes */ true);
        // nneded to make typeChecker to work properly
        (<any>ts).bindSourceFile(sourceFile, opts);
        return sourceFile.statements;
    }

    private processTSNode(node: ts.Node) {
        const statements = this.transpileTSNode(node);
        statements.forEach(s => {
            this.processStatementInternal(s);
        });
    }

    private processTSCode(code: string, parse?: any) {
        const statements = (!parse) ? this.transpileTSCode(code) : this.parseTSCode(code);
        statements.forEach(s => {
            this.processStatementInternal(s);
        });
    }

    private processJSCode(code: string) {
        const statements = this.parseJSCode(code);
        statements.forEach(s => {
            this.processStatementInternal(s);
        });
    }

    private processTryStatement(node: ts.TryStatement): void {

        // 1) get method pcall
        // prepare call for _ENV "pcall"
        // prepare consts
        const envInfo = this.resolver.returnResolvedEnv(this.functionContext);
        const pcallMethodInfo = this.resolver.returnConst('pcall', this.functionContext);

        const pcallResultInfo = this.functionContext.useRegisterAndPush();
        // getting method referene
        this.functionContext.code.push(
            [Ops.GETTABUP, pcallResultInfo.getRegister(), envInfo.getRegisterOrIndex(), pcallMethodInfo.getRegisterOrIndex()]);

        // 2) get closure
        // prepare Closure
        const protoIndex = this.functionContext.createProto(
            this.processFunction(node, node.tryBlock.statements, undefined));
        const closureResultInfo = this.functionContext.useRegisterAndPush();
        this.functionContext.code.push([Ops.CLOSURE, closureResultInfo.getRegister(), protoIndex]);

        // 3) calling closure
        // calling PCall
        this.functionContext.code.push([Ops.CALL, pcallResultInfo.getRegister(), 2, 3]);

        // 4) cleanup
        this.functionContext.stack.pop();
        this.functionContext.stack.pop();

        // creating 2 results
        const statusResultInfo = this.functionContext.useRegisterAndPush();
        statusResultInfo.identifierName = 'status';
        const errorResultInfo = this.functionContext.useRegisterAndPush();
        errorResultInfo.identifierName = 'error';

        // process "finally" block
        if (node.finallyBlock) {
            this.processBlock(node.finallyBlock);
        }

        // process 'catch'
        if (node.catchClause) {
            // if status == true, jump over 'catch'-es.
            // create 'true' boolean
            const resolvedInfo = this.resolver.returnConst(true, this.functionContext);

            const equalsTo = 1;
            this.functionContext.code.push([
                Ops.EQ, equalsTo, statusResultInfo.getRegisterOrIndex(), resolvedInfo.getRegisterOrIndex()]);

            const jmpOp = [Ops.JMP, 0, 0];
            this.functionContext.code.push(jmpOp);
            const casesBlockBegin = this.functionContext.code.length;

            // scope - begin
            this.functionContext.newLocalScope(node.catchClause);

            const variableDeclaration = node.catchClause.variableDeclaration;
            this.functionContext.createLocal((<ts.Identifier>variableDeclaration.name).text, errorResultInfo);

            node.catchClause.block.statements.forEach(s => {
                this.processStatement(s);
            });

            // scope - end
            this.functionContext.restoreLocalScope();

            // end of cases block
            jmpOp[2] = this.functionContext.code.length - casesBlockBegin;
        }

        // final cleanup error & status
        this.functionContext.stack.pop();
        this.functionContext.stack.pop();
    }

    private processThrowStatement(node: ts.ThrowStatement): void {
        const errorCall = ts.createCall(ts.createIdentifier('error'), undefined, [node.expression]);
        this.processExpression(errorCall);
    }

    private processTypeOfExpression(node: ts.TypeOfExpression): void {
        const typeCall = ts.createCall(ts.createIdentifier('type'), undefined, [node.expression]);
        typeCall.parent = node;
        this.processExpression(typeCall);
    }

    private processDebuggerStatement(node: ts.DebuggerStatement): void {
        const propertyAccessExpression = ts.createPropertyAccess(ts.createIdentifier('debug'), ts.createIdentifier('debug'));
        const debugCall = ts.createCall(
            propertyAccessExpression,
            undefined,
            []);
        // HACK: to stop applying calling SELF instead of GETTABLE
        /// propertyAccessExpression.parent = debugCall;
        debugCall.parent = node;
        this.processExpression(debugCall);
    }

    private processEnumDeclaration(node: ts.EnumDeclaration): void {
        this.functionContext.newLocalScope(node);
        this.processTSNode(node);
        this.functionContext.restoreLocalScope();
    }

    /*
    private processClassDeclaration(node: ts.ClassDeclaration): void {
        this.functionContext.newLocalScope(node);

        if (node.modifiers && node.modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
            this.emitGetOrCreateObjectExpression(node, 'exports');
        }

        const statements = this.parseTSNode(node, (js) => {
            if (node.heritageClauses) {
                // TODO: Hack, remove extra code to make code works
                js = js.replace('__extends(' + node.name.text + ', _super);', '');
                // TODO: Hack remove super call in constructor, implement apply on function
                js = js.replace('return _super !== null && _super.apply(this, arguments) || this;', '');
            }

            return js;
        });
        if (node.heritageClauses) {
            // skip first statement
            statements.slice(1).forEach(statement => {
                this.processStatement(statement);
            });
        } else {
            statements.forEach(statement => {
                this.processStatement(statement);
            });
        }

        this.functionContext.restoreLocalScope();

        // create proto object for inherited class
        this.emitInheritance(node);
    }
    */

    private processClassDeclaration(node: ts.ClassDeclaration): void {
        this.functionContext.newLocalScope(node);

        const properties = node.members
            .filter(m => this.isClassMemberAccepted(m))
            .map(m => ts.createPropertyAssignment(
                this.getClassMemberName(m),
                this.createClassMember(m)));

        if (this.isDefaultCtorRequired(node)) {
            // create defualt Ctor to initialize readonlys
            this.createDefaultCtor(node, properties);
        }

        // any get accessor
        if (node.members.some(m => m.kind === ts.SyntaxKind.GetAccessor)) {
            this.createAccessorsCollection(node, properties, true);
        }

        // any set accessor
        if (node.members.some(m => m.kind === ts.SyntaxKind.SetAccessor)) {
            this.createAccessorsCollection(node, properties, false);
        }

        // emit __index of base class
        const extend = this.getInheritanceFirst(node);
        if (extend) {
            properties.push(ts.createPropertyAssignment('__proto', ts.createIdentifier(extend.getText())));
            properties.push(ts.createPropertyAssignment('__index', ts.createIdentifier(extend.getText())));
        }

        const prototypeObject = ts.createAssignment(node.name, ts.createObjectLiteral(properties));
        prototypeObject.parent = node;
        this.processExpression(prototypeObject);

        // set metatable for derived class using __index dictionary containing base class
        if (extend) {
            const setmetatableCall = ts.createCall(ts.createIdentifier('setmetatable'), undefined, [node.name, node.name]);
            setmetatableCall.parent = node;
            this.processExpression(setmetatableCall);
        }

        this.emitExport(node.name, node);

        this.functionContext.restoreLocalScope();
    }

    private emitExport(name: ts.Identifier, node: ts.Node, fullNamespace?: boolean) {
        const isExport = node.modifiers && node.modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
        if (!isExport) {
            return;
        }

        if (this.extraDebugEmbed) {
            this.extraDebug(node, [ts.createStringLiteral('export class'), ts.createStringLiteral(name.text)]);
        }

        if (this.functionContext.namespaces.length === 0) {
            const isDefaultExport = node.modifiers && node.modifiers.some(m => m.kind === ts.SyntaxKind.DefaultKeyword);
            this.emitGetOrCreateObjectExpression(node, 'exports');
            const setExport = ts.createAssignment(
                ts.createPropertyAccess(ts.createIdentifier('exports'), !isDefaultExport ? name : 'default'), name);
            this.processExpression(setExport);
            return;
        }

        // save into module
        this.emitSaveToNamespace(name, fullNamespace);
    }

    private extraDebug(node: ts.Node, args: ReadonlyArray<ts.Expression>) {
        const extraPrint = ts.createCall(ts.createPropertyAccess(ts.createIdentifier('console'), 'log'), undefined, args);
        extraPrint.parent = node;
        this.processExpression(extraPrint);
    }

    private emitSaveToNamespace(name: ts.Identifier, fullNamespace?: boolean) {
        if (this.functionContext.namespaces.length === 0) {
            return;
        }

        // save into module
        const end = fullNamespace ? 0 : this.functionContext.namespaces.length - 1;

        let propertyAccessExpression;
        for (let i = this.functionContext.namespaces.length - 1; i >= end; i--) {
            const namespaceItem = this.functionContext.namespaces.at(i);
            if (propertyAccessExpression) {
                propertyAccessExpression = ts.createPropertyAccess(propertyAccessExpression, <ts.Identifier>namespaceItem.name);
            } else {
                propertyAccessExpression = ts.createPropertyAccess(namespaceItem.name, name);
            }
        }

        const setModuleExport = ts.createAssignment(propertyAccessExpression, name);
        this.processExpression(setModuleExport);
    }

    private createDefaultCtor(node: ts.ClassDeclaration, properties: ts.PropertyAssignment[]) {
        const defaultCtor = ts.createConstructor(undefined, undefined, [], <ts.Block><any>{
            kind: ts.SyntaxKind.Block,
            statements: []
        });
        defaultCtor.parent = node;
        properties.push(ts.createPropertyAssignment(this.getClassMemberName(defaultCtor), this.createClassMember(defaultCtor)));
    }

    private createAccessorsCollection(node: ts.ClassDeclaration, properties: ts.PropertyAssignment[], isGet: boolean) {
        const accessor = isGet ? ts.SyntaxKind.GetAccessor : ts.SyntaxKind.SetAccessor;
        const memberName = isGet ? '__get__' : '__set__';

        const accessorsProperties = node.members
            .filter(f => f.kind === accessor)
            .map(m => ts.createPropertyAssignment(m.name, this.createClassMember(m)));

        const accessorsMember = ts.createObjectLiteral(accessorsProperties);
        accessorsMember.parent = node;
        properties.push(ts.createPropertyAssignment(memberName, accessorsMember));
    }

    private isDefaultCtorRequired(node: ts.ClassDeclaration) {
        if (node.members.some(m => m.kind === ts.SyntaxKind.Constructor)) {
            return false;
        }

        return node.members.some(m => m.kind === ts.SyntaxKind.PropertyDeclaration
            && m.modifiers && m.modifiers.some(md => md.kind === ts.SyntaxKind.ReadonlyKeyword)
            && (<ts.PropertyDeclaration>m).initializer !== undefined)
            || node.members.some(m => m.kind === ts.SyntaxKind.GetAccessor || m.kind === ts.SyntaxKind.SetAccessor);
    }

    private createClassMember(memberDeclaration: ts.ClassElement): ts.Expression {
        switch (memberDeclaration.kind) {
            case ts.SyntaxKind.PropertyDeclaration:
                const propertyDeclaration = <ts.PropertyDeclaration>memberDeclaration;
                return propertyDeclaration.initializer;
            case ts.SyntaxKind.Constructor:
                const constructorDeclaration = <ts.ConstructorDeclaration>memberDeclaration;
                if (!constructorDeclaration.body) {
                    throw 1;
                }
                const constructorFunction = ts.createFunctionExpression(
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    constructorDeclaration.parameters,
                    constructorDeclaration.type, <ts.Block><any>{
                        kind: ts.SyntaxKind.Block,
                        statements: [
                            ...this.getClassInitStepsToSupportGetSetAccessor(memberDeclaration),
                            // initialized members
                            ...(<ts.ClassDeclaration>constructorDeclaration.parent).members
                                .filter(cm => cm.kind === ts.SyntaxKind.PropertyDeclaration
                                    && (<ts.PropertyDeclaration>cm).initializer
                                    && cm.modifiers && cm.modifiers.some(modifer => modifer.kind === ts.SyntaxKind.ReadonlyKeyword))
                                .map(p => ts.createStatement(
                                    ts.createAssignment(
                                        ts.createPropertyAccess(ts.createThis(), <ts.Identifier>p.name),
                                        (<ts.PropertyDeclaration>p).initializer))),
                            // members of class provided in ctor parameters
                            ...constructorDeclaration.parameters
                                .filter(p => p.modifiers && p.modifiers.some(md =>
                                    md.kind === ts.SyntaxKind.PrivateKeyword
                                    || md.kind === ts.SyntaxKind.ProtectedKeyword
                                    || md.kind === ts.SyntaxKind.PublicKeyword))
                                .map(p => ts.createStatement(
                                    ts.createAssignment(
                                        ts.createPropertyAccess(ts.createThis(), <ts.Identifier>p.name),
                                        <ts.Identifier>p.name))),
                            ...constructorDeclaration.body.statements
                        ]
                    });
                (<any>constructorFunction).__origin = constructorDeclaration;
                return constructorFunction;
            case ts.SyntaxKind.SetAccessor:
            case ts.SyntaxKind.GetAccessor:
            case ts.SyntaxKind.MethodDeclaration:
                const methodDeclaration = <ts.MethodDeclaration>memberDeclaration;
                const memberFunction = ts.createFunctionExpression(
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    methodDeclaration.parameters,
                    methodDeclaration.type, <ts.Block><any>{
                        kind: ts.SyntaxKind.Block,
                        statements: methodDeclaration.body.statements
                    });
                (<any>memberFunction).__origin = methodDeclaration;
                return memberFunction;
            default:
                throw new Error('Not Implemented');
        }
    }

    private getClassMemberName(memberDeclaration: ts.ClassElement):
        string | ts.Identifier | ts.StringLiteral | ts.NumericLiteral | ts.ComputedPropertyName {
        switch (memberDeclaration.kind) {
            case ts.SyntaxKind.Constructor:
                return 'constructor';
            case ts.SyntaxKind.SetAccessor:
                return 'set_' + (<ts.Identifier>memberDeclaration.name).text;
            case ts.SyntaxKind.GetAccessor:
                return 'get_' + (<ts.Identifier>memberDeclaration.name).text;
            default:
                return memberDeclaration.name;
        }
    }

    private isClassMemberAccepted(memberDeclaration: ts.ClassElement): any {
        // we do not need - abstract elements
        if (memberDeclaration.modifiers &&
            memberDeclaration.modifiers.some(modifer => modifer.kind === ts.SyntaxKind.AbstractKeyword)) {
                return false;
        }

        switch (memberDeclaration.kind) {
            case ts.SyntaxKind.PropertyDeclaration:
                const propertyDeclaration = <ts.PropertyDeclaration>memberDeclaration;
                return propertyDeclaration.initializer
                    && ((propertyDeclaration.modifiers
                        && propertyDeclaration.modifiers.some(modifer => modifer.kind === ts.SyntaxKind.StaticKeyword))
                        || propertyDeclaration.initializer.kind === ts.SyntaxKind.ArrowFunction);
            case ts.SyntaxKind.Constructor:
            case ts.SyntaxKind.MethodDeclaration:
                const methodDeclaration = <ts.MethodDeclaration>memberDeclaration;
                return methodDeclaration.body;
            case ts.SyntaxKind.GetAccessor:
            case ts.SyntaxKind.SetAccessor:
            case ts.SyntaxKind.SemicolonClassElement:
                return false;
            case ts.SyntaxKind.IndexSignature:
                // TODO: investigate implementatino of '[index: number]: T;'
                return false;
            default:
                throw new Error('Not Implemented');
        }
    }

    private getClassInitStepsToSupportGetSetAccessor(memberDeclaration: ts.ClassElement): any {
        const statements = [];
        const node = <ts.ClassDeclaration>memberDeclaration.parent;
        const anyGet = node.members.some(m => m.kind === ts.SyntaxKind.GetAccessor);
        const anySet = node.members.some(m => m.kind === ts.SyntaxKind.SetAccessor);
        if (!anyGet && !anySet) {
            return statements;
        }

        if (anyGet) {
            statements.push(ts.createStatement(
                ts.createAssignment(
                    ts.createPropertyAccess(ts.createThis(), '__index'),
                    ts.createIdentifier('__get_call__'))));
        }

        if (anySet) {
            statements.push(ts.createStatement(
                ts.createAssignment(
                    ts.createPropertyAccess(ts.createThis(), '__newindex'),
                    ts.createIdentifier('__set_call__'))));
        }

        return statements;
    }

    private getInheritanceFirst(node: ts.ClassDeclaration) {
        if (!node.heritageClauses) {
            return;
        }

        let extend;
        node.heritageClauses.forEach(heritageClause => {
            heritageClause.types.forEach(type => {
                if (!extend) {
                    extend = type.expression;
                }
            });
        });

        return extend;
    }

    private processModuleDeclaration(node: ts.ModuleDeclaration): void {

        this.functionContext.namespaces.push(node);

        this.fileModuleName = this.fileModuleName || node.name.text;

        this.emitGetOrCreateObjectExpression(node, node.name.text);
        if (node.body) {
            this.processStatement(<ts.ModuleBlock>node.body);
        }

        this.functionContext.namespaces.pop();

        this.emitSaveToNamespace(<ts.Identifier>node.name);
    }

    private processNamespaceDeclaration(node: ts.NamespaceDeclaration): void {
        this.processModuleDeclaration(node);
    }

    private processExportDeclaration(node: ts.ExportDeclaration): void {
        this.functionContext.newLocalScope(node);

        this.emitGetOrCreateObjectExpression(node, 'exports');

        this.processTSNode(node);
        this.functionContext.restoreLocalScope();
    }

    private processImportDeclaration(node: ts.ImportDeclaration): void {
        // 1) require './<nodule>'
        const requireCall = ts.createCall(ts.createIdentifier('require'), /*typeArguments*/ undefined, [node.moduleSpecifier]);
        requireCall.parent = node;
        this.processExpression(requireCall);

        // copy exported references from 'exports' object
        if (node.importClause) {
            if (node.importClause.namedBindings) {
                switch (node.importClause.namedBindings.kind) {
                    case ts.SyntaxKind.NamedImports:
                        const namedImports = <ts.NamedImports>node.importClause.namedBindings;
                        namedImports.elements.forEach(imp => {
                            const assignOfImport = ts.createAssignment(
                                imp.name,
                                ts.createPropertyAccess(ts.createIdentifier('exports'), imp.propertyName || imp.name));
                            assignOfImport.parent = node;
                            this.processExpression(assignOfImport);
                        });
                        break;
                    default:
                        throw new Error('Not Implemented');
                }
            } else {
                // default case
                const assignOfImport = ts.createAssignment(
                    node.importClause.name,
                    ts.createElementAccess(ts.createIdentifier('exports'), ts.createStringLiteral('default')));
                assignOfImport.parent = node;
                this.processExpression(assignOfImport);
            }
        }
    }

    private processVariableDeclarationList(declarationList: ts.VariableDeclarationList): void {
        declarationList.declarations.forEach(
            d => this.processVariableDeclarationOne((<ts.Identifier>d.name).text, d.initializer, Helpers.isConstOrLet(declarationList)));
    }

    private processVariableDeclarationOne(name: string, initializer: ts.Expression, isLetOrConst: boolean) {
        const localVar = this.functionContext.findScopedLocal(name, true);
        if (isLetOrConst && localVar === -1) {
            const localVarRegisterInfo = this.functionContext.createLocal(name);
            if (initializer) {
                this.processExpression(initializer);
            } else {
                this.processNullLiteral(null);
            }

            const rightNode = this.functionContext.stack.pop();
            this.functionContext.code.push([Ops.MOVE, localVarRegisterInfo.getRegister(), rightNode.getRegister()]);
        } else if (localVar !== -1) {
            if (initializer) {
                const localVarRegisterInfo = this.resolver.returnLocal(name, this.functionContext);
                this.processExpression(initializer);
                const rightNode = this.functionContext.stack.pop();
                this.functionContext.code.push([Ops.MOVE, localVarRegisterInfo.getRegister(), rightNode.getRegister()]);
            }
        } else {
            const nameConstIndex = -this.functionContext.findOrCreateConst(name);
            if (initializer) {
                this.processExpression(initializer);
                this.emitStoreToEnvObjectProperty(nameConstIndex);
            }
        }
    }

    private processVariableStatement(node: ts.VariableStatement): void {
        this.processVariableDeclarationList(node.declarationList);
    }

    private emitStoreToEnvObjectProperty(nameConstIndex: number) {
        const resolvedInfo = this.functionContext.stack.pop().optimize();

        this.functionContext.code.push([
            Ops.SETTABUP,
            this.resolver.returnResolvedEnv(this.functionContext).getRegisterOrIndex(),
            nameConstIndex,
            resolvedInfo.getRegisterOrIndex()]);
    }

    private processFunctionExpression(node: ts.FunctionExpression): void {
        if (!node.body) {
            // this is declaration
            return;
        }

        const protoIndex = this.functionContext.createProto(
            this.processFunction(node, node.body.statements, node.parameters));
        const resultInfo = this.functionContext.useRegisterAndPush();
        this.functionContext.code.push([Ops.CLOSURE, resultInfo.getRegister(), protoIndex]);
    }

    private processArrowFunction(node: ts.ArrowFunction): void {
        if (node.body.kind !== ts.SyntaxKind.Block) {
            // create body
            node.body = ts.createBlock([ts.createReturn(<ts.Expression>node.body)]);
        }

        this.processFunctionExpression(<any>node);
    }

    private processFunctionDeclaration(node: ts.FunctionDeclaration): void {
        if (node.modifiers && node.modifiers.some(m => m.kind === ts.SyntaxKind.DeclareKeyword)) {
            // skip it, as it is only declaration
            return;
        }

        const nameConstIndex = -this.functionContext.findOrCreateConst(node.name.text);
        this.processFunctionExpression(<ts.FunctionExpression><any>node);

        this.emitStoreToEnvObjectProperty(nameConstIndex);

        this.emitExport(node.name, node);
    }

    private processReturnStatement(node: ts.ReturnStatement): void {
        if (node.expression) {
            this.processExpression(node.expression);

            const resultInfo = this.functionContext.stack.pop();
            this.functionContext.code.push(
                [Ops.RETURN, resultInfo.getRegister(), 2]);
        } else {
            this.functionContext.code.push([Ops.RETURN, 0, 1]);
        }
    }

    private processIfStatement(node: ts.IfStatement): void {
        this.processExpression(node.expression);

        const equalsTo = 0;
        const ifExptNode = this.functionContext.stack.pop().optimize();

        const testSetOp = [Ops.TEST, ifExptNode.getRegisterOrIndex(), equalsTo];
        this.functionContext.code.push(testSetOp);

        const jmpOp = [Ops.JMP, 0, 1];
        this.functionContext.code.push(jmpOp);

        const beforeBlock = this.functionContext.code.length;

        this.processStatement(node.thenStatement);

        let jmpElseOp;
        let elseBlock;
        if (node.elseStatement) {
            jmpElseOp = [Ops.JMP, 0, 1];
            this.functionContext.code.push(jmpElseOp);

            elseBlock = this.functionContext.code.length;
        }

        jmpOp[2] = this.functionContext.code.length - beforeBlock;

        if (node.elseStatement) {
            this.processStatement(node.elseStatement);
            jmpElseOp[2] = this.functionContext.code.length - elseBlock;
        }
    }

    private processDoStatement(node: ts.DoStatement): void {
        this.emitLoop(node.expression, node);
    }

    private processWhileStatement(node: ts.WhileStatement): void {
        // jump to expression
        const jmpOp = [Ops.JMP, 0, 0];
        this.functionContext.code.push(jmpOp);

        const beforeBlock = this.functionContext.code.length;

        jmpOp[2] = this.emitLoop(node.expression, node) - beforeBlock;
    }

    private processForStatement(node: ts.ForStatement): void {

        this.functionContext.newLocalScope(node);

        this.declareLoopVariables(<ts.Expression>node.initializer);

        // jump to expression
        const jmpOp = [Ops.JMP, 0, 0];
        this.functionContext.code.push(jmpOp);

        const beforeBlock = this.functionContext.code.length;

        jmpOp[2] = this.emitLoop(node.condition, node, node.incrementor) - beforeBlock;

        this.functionContext.restoreLocalScope();
    }

    private declareLoopVariables(initializer: ts.Expression) {
        if (initializer) {
            if (initializer.kind === ts.SyntaxKind.Identifier) {
                this.processVariableDeclarationOne(initializer.getText(), undefined, true);
            } else {
                this.processExpression(<ts.Expression>initializer);
            }
        }
    }

    private markStack(): number {
        return this.functionContext.stack.getLength();
    }

    private rollbackUnused(stack: number) {
        if (stack < this.functionContext.stack.getLength()) {
            // we need to remove unused value
            this.functionContext.stack.pop();
        }
    }

    private emitLoop(expression: ts.Expression, node: ts.IterationStatement, incrementor?: ts.Expression): number {
        const beforeBlock = this.functionContext.code.length;

        this.processStatement(node.statement);

        this.resolveContinueJumps();

        if (incrementor) {
            const stackSize = this.markStack();
            this.processExpression(incrementor);
            this.rollbackUnused(stackSize);
        }

        const expressionBlock = this.functionContext.code.length;

        if (expression) {
            this.processExpression(expression);

            const ifExptNode = this.functionContext.stack.pop().optimize();

            const equalsTo = 1;
            const testSetOp = [Ops.TEST, ifExptNode.getRegisterOrIndex(), 0 /*unused*/, equalsTo];
            this.functionContext.code.push(testSetOp);
        }

        const jmpOp = [Ops.JMP, 0, beforeBlock - this.functionContext.code.length - 1];
        this.functionContext.code.push(jmpOp);

        this.resolveBreakJumps();

        return expressionBlock;
    }

    private processForInStatement(node: ts.ForInStatement): void {
        this.functionContext.newLocalScope(node);
        this.processForInStatementNoScope(node);
        this.functionContext.restoreLocalScope();
    }

    private processForInStatementNoScope(node: ts.ForInStatement): void {
        // we need to generate 3 local variables for ForEach loop
        const generatorInfo = this.functionContext.createLocal('<generator>');
        const stateInfo = this.functionContext.createLocal('<state>');
        const controlInfo = this.functionContext.createLocal('<control>');

        // initializer
        this.declareLoopVariables(<ts.Expression>node.initializer);

        // call PAIRS(...) before jump
        // TODO: finish it
        this.processExpression(node.expression);

        // prepare call for _ENV "pairs"
        // prepare consts
        const envInfo = this.resolver.returnResolvedEnv(this.functionContext);
        const pairsMethodInfo = this.resolver.returnConst('pairs', this.functionContext);

        const expressionResultInfo = this.functionContext.stack.peek();
        // getting method referene
        this.functionContext.code.push(
            [Ops.GETTABUP, generatorInfo.getRegister(), envInfo.getRegisterOrIndex(), pairsMethodInfo.getRegisterOrIndex()]);

        // first parameter of method call "pairs"
        if (expressionResultInfo.getRegisterOrIndex() < 0) {
            this.functionContext.code.push(
                [Ops.LOADK, stateInfo.getRegister(), expressionResultInfo.getRegisterOrIndex()]);
        } else {
            this.functionContext.code.push(
                [Ops.MOVE, stateInfo.getRegister(), expressionResultInfo.getRegisterOrIndex()]);
        }

        // finally - calling method 'pairs'
        this.functionContext.code.push(
            [Ops.CALL, generatorInfo.getRegister(), 2, 4]);

        // cleaning up stack, first parameter, method ref, and expression
        this.functionContext.stack.pop();

        // jump to expression
        const initialJmpOp = [Ops.JMP, 0, 0];
        this.functionContext.code.push(initialJmpOp);

        const beforeBlock = this.functionContext.code.length;

        this.processStatement(node.statement);

        const loopOpsBlock = this.functionContext.code.length;

        this.resolveContinueJumps();

        // !!!! TODO: problem in calling this code, something happening to NULL value
        const tforCallOp = [Ops.TFORCALL, generatorInfo.getRegister(), 0, 1];
        this.functionContext.code.push(tforCallOp);

        // replace with TFORLOOP
        const tforLoopOp = [Ops.TFORLOOP, controlInfo.getRegister(), beforeBlock - this.functionContext.code.length - 1];
        this.functionContext.code.push(tforLoopOp);

        // storing jump address
        initialJmpOp[2] = loopOpsBlock - beforeBlock;

        this.resolveBreakJumps();
    }

    private processForOfStatement(node: ts.ForOfStatement): void {
        // Somehow #len returns 2 for 3 elements. why????? - solution, skip for/of when array[0] === null
        const indexerName = 'i_';
        const declIndexer = ts.createVariableDeclaration(indexerName, undefined, ts.createNumericLiteral('0'));
        const arrayItem = <ts.Identifier>(<ts.VariableDeclarationList>node.initializer).declarations[0].name;
        const arrayItemInitialization = ts.createVariableDeclaration(
            arrayItem, undefined, ts.createElementAccess(node.expression, ts.createIdentifier(indexerName)));
        // to make it LET
        const newStatementBlock = ts.createBlock(
            [
                ts.createStatement(<ts.Expression><any>ts.createVariableDeclarationList([arrayItemInitialization], ts.NodeFlags.Const)),
                node.statement
            ]);

        const lengthMemeber = ts.createIdentifier('length');
        (<any>lengthMemeber).__len = true;

        // to make it LET
        const forStatement =
            ts.createFor(ts.createVariableDeclarationList([declIndexer], ts.NodeFlags.Const),
                ts.createBinary(
                    ts.createIdentifier(indexerName),
                    ts.SyntaxKind.LessThanEqualsToken, ts.createPropertyAccess(node.expression, lengthMemeber)),
                ts.createPostfixIncrement(ts.createIdentifier(indexerName)),
                newStatementBlock);

        // to support variable resolvation
        this.bind(forStatement);

        forStatement.parent = node.parent;
        (<any>forStatement).__origin = node;

        const ifStatement = ts.createIf(ts.createElementAccess(node.expression, ts.createNumericLiteral('0')), forStatement);

        this.processStatement(ifStatement);
    }

    private processBreakStatement(node: ts.BreakStatement) {
        const breakJmpOp = [Ops.JMP, 0, 0];
        this.functionContext.code.push(breakJmpOp);
        this.functionContext.breaks.push(this.functionContext.code.length - 1);
    }

    private resolveBreakJumps(jump?: number) {
        this.functionContext.breaks.forEach(b => {
            this.functionContext.code.codeAt(b)[2] = (jump ? jump : this.functionContext.code.length) - b - 1;
        });

        this.functionContext.breaks = [];
    }

    private processContinueStatement(node: ts.ContinueStatement) {
        const continueJmpOp = [Ops.JMP, 0, 0];
        this.functionContext.code.push(continueJmpOp);
        this.functionContext.continues.push(this.functionContext.code.length - 1);
    }

    private resolveContinueJumps(jump?: number) {
        this.functionContext.continues.forEach(c => {
            this.functionContext.code.codeAt(c)[2] = (jump ? jump : this.functionContext.code.length) - c - 1;
        });

        this.functionContext.continues = [];
    }

    private processSwitchStatement(node: ts.SwitchStatement) {
        this.processExpression(node.expression);

        this.functionContext.newLocalScope(node);

        const switchResultInfo = this.functionContext.stack.peek();

        let previousCaseJmpIndex = -1;
        let lastCaseJmpIndexes: number[] = [];
        node.caseBlock.clauses.forEach(c => {

            // set jump for previouse 'false' case;
            if (previousCaseJmpIndex !== -1) {
                if (this.functionContext.code.codeAt(previousCaseJmpIndex)[2] !== 0) {
                    throw new Error('Jump is set already');
                }

                this.functionContext.code.codeAt(previousCaseJmpIndex)[2] = this.functionContext.code.length - previousCaseJmpIndex - 1;
                previousCaseJmpIndex = -1;
            }

            if (c.kind === ts.SyntaxKind.CaseClause) {
                // process 'case'
                const caseClause = <ts.CaseClause>c;
                this.processExpression(caseClause.expression);

                const caseResultInfo = this.functionContext.stack.pop().optimize();

                const equalsTo = 1;
                this.functionContext.code.push([
                    Ops.EQ, equalsTo, switchResultInfo.getRegisterOrIndex(), caseResultInfo.getRegisterOrIndex()]);
                const jmpOp = [Ops.JMP, 0, 0];
                this.functionContext.code.push(jmpOp);
                lastCaseJmpIndexes.push(this.functionContext.code.length - 1);
            }

            if (c.statements.length > 0) {
                if (c.kind === ts.SyntaxKind.CaseClause) {
                    // jump over the case
                    const jmpOp = [Ops.JMP, 0, 0];
                    this.functionContext.code.push(jmpOp);
                    previousCaseJmpIndex = this.functionContext.code.length - 1;
                }

                // set jump to body of the case
                lastCaseJmpIndexes.forEach(j => {
                    if (this.functionContext.code.codeAt(j)[2] !== 0) {
                        throw new Error('Jump is set already');
                    }

                    this.functionContext.code.codeAt(j)[2] = this.functionContext.code.length - j - 1;
                });

                lastCaseJmpIndexes = [];
            }

            // case or default body
            c.statements.forEach(s => this.processStatement(s));
        });

        // clearup switch result;
        this.functionContext.restoreLocalScope();

        this.functionContext.stack.pop();

        this.resolveBreakJumps();
    }

    private processBlock(node: ts.Block): void {

        this.functionContext.newLocalScope(node);

        node.statements.forEach(s => {
            this.processStatement(s);
        });

        this.functionContext.restoreLocalScope();
    }

    private processModuleBlock(node: ts.ModuleBlock): void {

        this.functionContext.newLocalScope(node);

        node.statements.forEach(s => {
            this.processStatement(s);
        });

        this.functionContext.restoreLocalScope();
    }

    private processBooleanLiteral(node: ts.BooleanLiteral): void {
        const boolValue = node.kind === ts.SyntaxKind.TrueKeyword;
        const opCode = [Ops.LOADBOOL, this.functionContext.useRegisterAndPush().getRegister(), boolValue ? 1 : 0, 0];
        this.functionContext.code.push(opCode);
    }

    private processNullLiteral(node: ts.NullLiteral): void {
        const resultInfo = this.functionContext.useRegisterAndPush();
        // LOADNIL A B     R(A), R(A+1), ..., R(A+B) := nil
        this.functionContext.code.push([Ops.LOADNIL, resultInfo.getRegister(), 0]);
    }

    private processNumericLiteral(node: ts.NumericLiteral): void {
        this.emitNumericConst(node.text);
    }

    private emitNumericConst(text: string): void {
        const resultInfo = this.functionContext.useRegisterAndPush();
        const resolvedInfo = this.resolver.returnConst(
            text.indexOf('.') === -1 ? parseInt(text, 10) : parseFloat(text), this.functionContext);
        // LOADK A Bx    R(A) := Kst(Bx)
        this.functionContext.code.push([Ops.LOADK, resultInfo.getRegister(), resolvedInfo.getRegisterOrIndex()]);
    }

    private processStringLiteral(node: ts.StringLiteral): void {
        const resultInfo = this.functionContext.useRegisterAndPush();
        const resolvedInfo = this.resolver.returnConst(node.text, this.functionContext);
        // LOADK A Bx    R(A) := Kst(Bx)
        this.functionContext.code.push([Ops.LOADK, resultInfo.getRegister(), resolvedInfo.getRegisterOrIndex()]);
    }

    private processNoSubstitutionTemplateLiteral(node: ts.NoSubstitutionTemplateLiteral): void {
        this.processStringLiteral(<ts.StringLiteral><any>node);
    }

    private processTemplateExpression(node: ts.TemplateExpression): void {
        this.processTSNode(node);
    }

    private processRegularExpressionLiteral(node: ts.RegularExpressionLiteral): void {
        // TODO: temporary hack for Regular Expressions
        this.processExpression(ts.createStringLiteral(node.getText()));
    }

    private processObjectLiteralExpression(node: ts.ObjectLiteralExpression): void {
        const resultInfo = this.functionContext.useRegisterAndPush();
        this.functionContext.code.push([
            Ops.NEWTABLE,
            resultInfo.getRegister(),
            node.properties.length,
            0]);

        node.properties.filter(e => e.kind !== ts.SyntaxKind.SpreadAssignment).forEach((e: ts.ObjectLiteralElementLike, index: number) => {
            // set 0 element
            this.resolver.Scope.push(node);
            this.processExpression(<ts.Expression><any>e.name);
            this.resolver.Scope.pop();

            // we need to remove scope as expression is not part of object
            if (e.kind === ts.SyntaxKind.ShorthandPropertyAssignment) {
                this.processExpression(<ts.Expression><any>e.name);
            } else if (e.kind === ts.SyntaxKind.PropertyAssignment) {
                this.processExpression(e.initializer);
            } else {
                throw new Error('Not Implemeneted');
            }

            const propertyValueInfo = this.functionContext.stack.pop().optimize();
            const propertyIndexInfo = this.functionContext.stack.pop().optimize();

            this.functionContext.code.push(
                [Ops.SETTABLE,
                resultInfo.getRegister(),
                propertyIndexInfo.getRegisterOrIndex(),
                propertyValueInfo.getRegisterOrIndex()]);
        });

        node.properties.filter(e => e.kind === ts.SyntaxKind.SpreadAssignment).forEach((e: ts.ObjectLiteralElementLike, index: number) => {
            // creating foreach loop for each spread object
            const spreadAssignment = <ts.SpreadAssignment>e;

            const objLocal = ts.createIdentifier('obj_');
            objLocal.flags = ts.NodeFlags.Const;
            const indexLocal = ts.createIdentifier('i_');
            const forInSetStatement = ts.createForIn(
                ts.createVariableDeclarationList([ts.createVariableDeclaration(indexLocal)], ts.NodeFlags.Const),
                spreadAssignment.expression,
                ts.createStatement(ts.createAssignment(
                    ts.createElementAccess(objLocal, indexLocal),
                    ts.createElementAccess(spreadAssignment.expression, indexLocal))));
            forInSetStatement.parent = node;
            // this is important call to allow to resolve local variables
            // TODO: but it does not work here, why?
            // this.bind(forInSetStatement);

            this.functionContext.newLocalScope(forInSetStatement);
            this.functionContext.createLocal('obj_', resultInfo);
            this.processForInStatementNoScope(forInSetStatement);
            this.functionContext.restoreLocalScope();
        });
    }

    private processArrayLiteralExpression(node: ts.ArrayLiteralExpression): void {
        const resultInfo = this.functionContext.useRegisterAndPush();
        this.functionContext.code.push([
            Ops.NEWTABLE,
            resultInfo.getRegister(),
            node.elements.length,
            0]);

        if (node.elements.length > 0) {
            // set 0 element
            this.processExpression(<ts.NumericLiteral>{ kind: ts.SyntaxKind.NumericLiteral, text: '0' });
            this.processExpression(node.elements[0]);

            const zeroValueInfo = this.functionContext.stack.pop().optimize();
            const zeroIndexInfo = this.functionContext.stack.pop().optimize();

            this.functionContext.code.push(
                [Ops.SETTABLE,
                resultInfo.getRegister(),
                zeroIndexInfo.getRegisterOrIndex(),
                zeroValueInfo.getRegisterOrIndex()]);

            // set 1.. elements
            const reversedValues = (<Array<any>><any>node.elements.slice(1));

            reversedValues.forEach((e, index: number) => {
                this.processExpression(e);
            });

            reversedValues.forEach(a => {
                // pop method arguments
                this.functionContext.stack.pop();
            });

            if (node.elements.length > 511) {
                throw new Error('finish using C in SETLIST');
            }

            this.functionContext.code.push(
                [Ops.SETLIST, resultInfo.getRegister(), reversedValues.length, 1]);
        }
    }

    private processElementAccessExpression(node: ts.ElementAccessExpression): void {
        this.processExpression(node.expression);
        this.processExpression(node.argumentExpression);

        // perform load
        const indexInfo = this.functionContext.stack.pop().optimize();
        const variableInfo = this.functionContext.stack.pop().optimize();

        const resultInfo = this.functionContext.useRegisterAndPush();
        this.functionContext.code.push(
            [Ops.GETTABLE,
            resultInfo.getRegister(),
            variableInfo.getRegisterOrIndex(),
            indexInfo.getRegisterOrIndex()]);
    }

    private processParenthesizedExpression(node: ts.ParenthesizedExpression) {
        this.processExpression(node.expression);
    }

    private processTypeAssertionExpression(node: ts.TypeAssertion) {
        this.processExpression(node.expression);
    }

    private processPrefixUnaryExpression(node: ts.PrefixUnaryExpression): void {

        // TODO: this code can be improved by ataching Ops codes to ResolvedInfo instead of guessing where the beginning of the command
        const operandPosition = this.functionContext.code.length;

        this.processExpression(node.operand);

        let opCode;
        switch (node.operator) {
            case ts.SyntaxKind.MinusToken:
            case ts.SyntaxKind.TildeToken:
            case ts.SyntaxKind.ExclamationToken:
                switch (node.operator) {
                    case ts.SyntaxKind.MinusToken:
                        opCode = Ops.UNM;
                        break;
                    case ts.SyntaxKind.TildeToken:
                        opCode = Ops.BNOT;
                        break;
                    case ts.SyntaxKind.ExclamationToken:
                        opCode = Ops.NOT;
                        break;
                }

                // no optimization required as expecting only Registers
                const rightNode = this.functionContext.stack.pop();
                const resultInfo = this.functionContext.useRegisterAndPush();

                this.functionContext.code.push([
                    opCode,
                    resultInfo.getRegister(),
                    rightNode.getRegisterOrIndex()]);
                break;

            case ts.SyntaxKind.PlusPlusToken:
            case ts.SyntaxKind.MinusMinusToken:
                switch (node.operator) {
                    case ts.SyntaxKind.PlusPlusToken:
                        opCode = Ops.ADD;
                        break;
                    case ts.SyntaxKind.MinusMinusToken:
                        opCode = Ops.SUB;
                        break;
                }

                this.emitNumericConst('1');

                // +/- 1
                const value1Info = this.functionContext.stack.pop().optimize();
                const operandInfo = this.functionContext.stack.pop().optimize();
                const resultPlusOrMinusInfo = this.functionContext.useRegisterAndPush();

                this.functionContext.code.push([
                    opCode,
                    resultPlusOrMinusInfo.getRegister(),
                    operandInfo.getRegister(),
                    value1Info.getRegisterOrIndex()]);

                // save
                const operationResultInfo = this.functionContext.stack.pop();
                const readOpCode = this.functionContext.code.codeAt(operandPosition);
                if (readOpCode && readOpCode[0] === Ops.GETTABUP) {
                    this.functionContext.code.push([
                        Ops.SETTABUP,
                        readOpCode[2],
                        readOpCode[3],
                        operandInfo.getRegister()
                    ]);
                } else if (readOpCode && readOpCode[0] === Ops.GETTABLE) {
                    this.functionContext.code.push([
                        Ops.SETTABLE,
                        readOpCode[2],
                        readOpCode[3],
                        operandInfo.getRegister()
                    ]);
                } else if (readOpCode && readOpCode[0] === Ops.GETUPVAL) {
                    this.functionContext.code.push([
                        Ops.SETUPVAL,
                        readOpCode[2],
                        operandInfo.getRegister()
                    ]);
                } else if (operandInfo.kind === ResolvedKind.Register) {
                    this.functionContext.code.push([
                        Ops.MOVE,
                        (operandInfo.originalInfo || operandInfo).getRegister(),
                        operationResultInfo.getRegister()]);
                }

                // clone value
                if (!this.isValueNotRequired(node.parent)) {
                    this.functionContext.stack.push(operationResultInfo);
                }

                break;
        }
    }

    private processPostfixUnaryExpression(node: ts.PostfixUnaryExpression): void {
        // TODO: this code can be improved by ataching Ops codes to ResolvedInfo instead of guessing where the beginning of the command
        const operandPosition = this.functionContext.code.length;

        this.processExpression(node.operand);

        let opCode;
        switch (node.operator) {
            case ts.SyntaxKind.PlusPlusToken:
            case ts.SyntaxKind.MinusMinusToken:
                switch (node.operator) {
                    case ts.SyntaxKind.PlusPlusToken:
                        opCode = Ops.ADD;
                        break;
                    case ts.SyntaxKind.MinusMinusToken:
                        opCode = Ops.SUB;
                        break;
                }

                // clone
                const operandInfo = this.functionContext.stack.peek();

                this.emitNumericConst('1');
                const value1Info = this.functionContext.stack.pop().optimize();

                // +/- 1
                const resultPlusOrMinuesInfo = this.functionContext.useRegisterAndPush();
                this.functionContext.code.push([
                    opCode,
                    resultPlusOrMinuesInfo.getRegister(),
                    operandInfo.getRegister(),
                    value1Info.getRegisterOrIndex()]);

                // consumed operand. we need to pop here to maintain order of used registers
                this.functionContext.stack.pop();

                // save
                const readOpCode = this.functionContext.code.codeAt(operandPosition);
                if (readOpCode && readOpCode[0] === Ops.GETTABUP) {
                    this.functionContext.code.push([
                        Ops.SETTABUP,
                        readOpCode[2],
                        readOpCode[3],
                        resultPlusOrMinuesInfo.getRegister()
                    ]);
                } else if (readOpCode && readOpCode[0] === Ops.GETTABLE) {
                    this.functionContext.code.push([
                        Ops.SETTABLE,
                        readOpCode[2],
                        readOpCode[3],
                        resultPlusOrMinuesInfo.getRegister()
                    ]);
                } else if (readOpCode && readOpCode[0] === Ops.MOVE) {
                    this.functionContext.code.push([
                        Ops.MOVE,
                        readOpCode[2],
                        resultPlusOrMinuesInfo.getRegister()]);
                }

                if (this.isValueNotRequired(node.parent)) {
                    this.functionContext.stack.pop();
                }

                break;
        }
    }

    private processConditionalExpression(node: ts.ConditionalExpression): void {
        this.processExpression(node.condition);

        const equalsTo = 0;
        const conditionInfo = this.functionContext.stack.pop().optimize();
        const resultInfo = this.functionContext.useRegisterAndPush();

        const testSetOp = [Ops.TEST, conditionInfo.getRegisterOrIndex(), equalsTo];
        this.functionContext.code.push(testSetOp);

        const jmpOp = [Ops.JMP, 0, 1];
        this.functionContext.code.push(jmpOp);

        const beforeBlock = this.functionContext.code.length;

        this.processExpression(node.whenTrue);
        const whenTrueInfo = this.functionContext.stack.pop().optimize();

        if (whenTrueInfo.getRegisterOrIndex() < 0) {
            this.functionContext.code.push([
                Ops.LOADK,
                resultInfo.getRegister(),
                whenTrueInfo.getRegisterOrIndex(),
                0]);
        } else {
            this.functionContext.code.push([
                Ops.MOVE,
                resultInfo.getRegister(),
                whenTrueInfo.getRegister(),
                0]);
        }

        const jmpElseOp = [Ops.JMP, 0, 1];
        this.functionContext.code.push(jmpElseOp);

        const elseBlock = this.functionContext.code.length;

        jmpOp[2] = this.functionContext.code.length - beforeBlock;

        this.processExpression(node.whenFalse);
        const whenFalseInfo = this.functionContext.stack.pop().optimize();

        if (whenFalseInfo.getRegisterOrIndex() < 0) {
            this.functionContext.code.push([
                Ops.LOADK,
                resultInfo.getRegister(),
                whenFalseInfo.getRegisterOrIndex(),
                0]);
        } else {
            this.functionContext.code.push([
                Ops.MOVE,
                resultInfo.getRegister(),
                whenFalseInfo.getRegister(),
                0]);
        }

        jmpElseOp[2] = this.functionContext.code.length - elseBlock;
    }

    private processBinaryExpression(node: ts.BinaryExpression): void {
        // perform '='
        switch (node.operatorToken.kind) {
            case ts.SyntaxKind.EqualsToken:

                // ... = <right>
                this.processExpression(node.right);

                // <left> = ...
                this.processExpression(node.left);

                this.emitAssignOperation(node);

                break;

            case ts.SyntaxKind.PlusToken:
            case ts.SyntaxKind.MinusToken:
            case ts.SyntaxKind.AsteriskToken:
            case ts.SyntaxKind.AsteriskAsteriskToken:
            case ts.SyntaxKind.PercentToken:
            case ts.SyntaxKind.CaretToken:
            case ts.SyntaxKind.SlashToken:
            case ts.SyntaxKind.AmpersandToken:
            case ts.SyntaxKind.BarToken:
            case ts.SyntaxKind.CaretToken:
            case ts.SyntaxKind.LessThanLessThanToken:
            case ts.SyntaxKind.GreaterThanGreaterThanToken:
            case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:

            case ts.SyntaxKind.PlusEqualsToken:
            case ts.SyntaxKind.MinusEqualsToken:
            case ts.SyntaxKind.AsteriskEqualsToken:
            case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
            case ts.SyntaxKind.PercentEqualsToken:
            case ts.SyntaxKind.CaretEqualsToken:
            case ts.SyntaxKind.SlashEqualsToken:
            case ts.SyntaxKind.AmpersandEqualsToken:
            case ts.SyntaxKind.BarEqualsToken:
            case ts.SyntaxKind.CaretEqualsToken:
            case ts.SyntaxKind.LessThanLessThanEqualsToken:
            case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
            case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:

                let leftOpNode;
                let rightOpNode;

                let operationCode = this.opsMap[node.operatorToken.kind];
                if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
                    try {
                        const typeResult = this.resolver.getTypeAtLocation(node);
                        if (typeResult && typeResult.intrinsicName === 'string') {
                            operationCode = Ops.CONCAT;
                        }
                    } catch (e) {
                        console.warn('Can\'t get type of "' + node.getText() + '"');
                    }
                }

                // <left> + ...
                this.processExpression(node.left);

                // ... + <right>
                this.processExpression(node.right);


                if (operationCode === Ops.CONCAT) {
                    rightOpNode = this.functionContext.stack.pop();
                    leftOpNode = this.functionContext.stack.pop();
                } else {
                    rightOpNode = this.functionContext.stack.pop().optimize();
                    leftOpNode = this.functionContext.stack.pop().optimize();
                }

                const resultInfo = this.functionContext.useRegisterAndPush();

                this.functionContext.code.push([
                    operationCode,
                    resultInfo.getRegister(),
                    leftOpNode.getRegisterOrIndex(),
                    rightOpNode.getRegisterOrIndex()]);

                // we need to store result at the end of operation
                switch (node.operatorToken.kind) {
                    case ts.SyntaxKind.PlusEqualsToken:
                    case ts.SyntaxKind.MinusEqualsToken:
                    case ts.SyntaxKind.AsteriskEqualsToken:
                    case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
                    case ts.SyntaxKind.PercentEqualsToken:
                    case ts.SyntaxKind.CaretEqualsToken:
                    case ts.SyntaxKind.SlashEqualsToken:
                    case ts.SyntaxKind.AmpersandEqualsToken:
                    case ts.SyntaxKind.BarEqualsToken:
                    case ts.SyntaxKind.CaretEqualsToken:
                    case ts.SyntaxKind.LessThanLessThanEqualsToken:
                    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
                    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:

                        // <left> = ...
                        this.processExpression(node.left);

                        this.emitAssignOperation(node);
                        break;
                }

                break;

            case ts.SyntaxKind.EqualsEqualsToken:
            case ts.SyntaxKind.EqualsEqualsEqualsToken:
            case ts.SyntaxKind.LessThanToken:
            case ts.SyntaxKind.LessThanEqualsToken:
            case ts.SyntaxKind.ExclamationEqualsToken:
            case ts.SyntaxKind.ExclamationEqualsEqualsToken:
            case ts.SyntaxKind.GreaterThanToken:
            case ts.SyntaxKind.GreaterThanEqualsToken:

                // ... = <right>
                this.processExpression(node.right);

                // <left> = ...
                this.processExpression(node.left);

                const leftOpNode2 = this.functionContext.stack.pop().optimize();
                const rightOpNode2 = this.functionContext.stack.pop().optimize();
                const resultInfo2 = this.functionContext.useRegisterAndPush();

                let equalsTo = 1;
                switch (node.operatorToken.kind) {
                    case ts.SyntaxKind.ExclamationEqualsToken:
                    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
                    case ts.SyntaxKind.GreaterThanToken:
                    case ts.SyntaxKind.GreaterThanEqualsToken:
                        equalsTo = 0;
                        break;
                }

                this.functionContext.code.push([
                    this.opsMap[node.operatorToken.kind],
                    equalsTo,
                    leftOpNode2.getRegisterOrIndex(),
                    rightOpNode2.getRegisterOrIndex()]);

                // in case of logical ops finish it
                const trueValue = 1;
                const falseValue = 0;

                this.functionContext.code.push([
                    Ops.JMP,
                    0,
                    1]);

                this.functionContext.code.push([
                    Ops.LOADBOOL,
                    resultInfo2.getRegister(),
                    falseValue,
                    1]);

                this.functionContext.code.push([
                    Ops.LOADBOOL,
                    resultInfo2.getRegister(),
                    trueValue,
                    0]);

                break;

            case ts.SyntaxKind.AmpersandAmpersandToken:
            case ts.SyntaxKind.BarBarToken:

                // <left> = ...
                this.processExpression(node.left);

                const leftOpNode3 = this.functionContext.stack.pop().optimize();

                let equalsTo2 = 0;
                switch (node.operatorToken.kind) {
                    case ts.SyntaxKind.BarBarToken:
                        equalsTo2 = 1;
                        break;
                }

                const testSetOp = [
                    Ops.TESTSET,
                    undefined,
                    leftOpNode3.getRegisterOrIndex(),
                    equalsTo2];
                this.functionContext.code.push(testSetOp);

                const jmpOp = [
                    Ops.JMP,
                    0,
                    1];
                this.functionContext.code.push(jmpOp);
                const beforeBlock = this.functionContext.code.length;

                // ... = <right>
                this.processExpression(node.right);

                const rightOpNode3 = this.functionContext.stack.pop().optimize();
                const resultInfo3 = this.functionContext.useRegisterAndPush();
                testSetOp[1] = resultInfo3.getRegister();

                if (rightOpNode3.getRegisterOrIndex() < 0) {
                    this.functionContext.code.push([
                        Ops.LOADK,
                        resultInfo3.getRegister(),
                        rightOpNode3.getRegisterOrIndex(),
                        0]);
                } else {
                    this.functionContext.code.push([
                        Ops.MOVE,
                        resultInfo3.getRegister(),
                        rightOpNode3.getRegister(),
                        0]);
                }

                jmpOp[2] = this.functionContext.code.length - beforeBlock;

                break;

            case ts.SyntaxKind.InKeyword:

                const inExpression = ts.createBinary(
                    ts.createElementAccess(node.right, node.left),
                    ts.SyntaxKind.ExclamationEqualsEqualsToken,
                    ts.createNull());
                inExpression.parent = node.parent;
                this.processExpression(inExpression);

                break;

            case ts.SyntaxKind.CommaToken:

                this.processExpression(node.left);
                this.processExpression(node.right);

                break;

            case ts.SyntaxKind.InstanceOfKeyword:
                // TODO: temporary solution, finish it
                /*
                const instanceOfExpression = ts.createBinary(
                    ts.createTypeOf(node.right),
                    ts.SyntaxKind.EqualsEqualsToken,
                    node.left);
                instanceOfExpression.parent = node.parent;
                this.processExpression(instanceOfExpression);
                */

                const instanceOfCall = ts.createCall(ts.createIdentifier('__instanceof'), undefined, [node.left, node.right]);
                instanceOfCall.parent = node.parent;
                this.processExpression(instanceOfCall);

                break;

            default: throw new Error('Not Implemented');
        }
    }

    private emitAssignOperation(node: ts.Node) {
        const leftOperandInfo = this.functionContext.stack.pop();
        const rightOperandInfo = this.functionContext.stack.pop();
        const readOpCode = this.functionContext.code.latest;

        if (leftOperandInfo.kind === ResolvedKind.Register) {
            if (readOpCode[0] === Ops.GETTABUP) {
                if (node.parent && node.parent.kind !== ts.SyntaxKind.ExpressionStatement) {
                    // we need to store register in stack to reuse it in next expression
                    this.functionContext.stack.push(rightOperandInfo);
                }
                // left of = is method reference
                const getTabUpOpArray = this.functionContext.code.pop();
                rightOperandInfo.optimize();
                this.functionContext.code.push([
                    Ops.SETTABUP,
                    getTabUpOpArray[2],
                    getTabUpOpArray[3],
                    rightOperandInfo.getRegisterOrIndex()
                ]);
            } else if (readOpCode[0] === Ops.GETTABLE) {
                if (node.parent && node.parent.kind !== ts.SyntaxKind.ExpressionStatement) {
                    // we need to store register in stack to reuse it in next expression
                    this.functionContext.stack.push(rightOperandInfo);
                }
                // left of = is method reference
                const getTableOpArray = this.functionContext.code.pop();
                rightOperandInfo.optimize();
                this.functionContext.code.push([
                    Ops.SETTABLE,
                    getTableOpArray[2],
                    getTableOpArray[3],
                    rightOperandInfo.getRegisterOrIndex()
                ]);
            } else if (readOpCode[0] === Ops.GETUPVAL) {
                if (node.parent && node.parent.kind !== ts.SyntaxKind.ExpressionStatement) {
                    // we need to store register in stack to reuse it in next expression
                    this.functionContext.stack.push(rightOperandInfo);
                }
                const getUpValueArray = this.functionContext.code.pop();
                // Optimization can't be used here
                this.functionContext.code.push([
                    Ops.SETUPVAL,
                    rightOperandInfo.getRegisterOrIndex(),
                    getUpValueArray[2]
                ]);
            } else if (readOpCode[0] === Ops.MOVE) {
                if (node.parent && node.parent.kind !== ts.SyntaxKind.ExpressionStatement) {
                    // we need to store register in stack to reuse it in next expression
                    this.functionContext.stack.push(leftOperandInfo);
                }
                // if we put local var value we need to remove it
                const readMoveOpArray = this.functionContext.code.pop();
                leftOperandInfo.register = readMoveOpArray[2];
                this.functionContext.code.push([Ops.MOVE, leftOperandInfo.getRegister(), rightOperandInfo.getRegister()]);
            } else {
                if (node.parent && node.parent.kind !== ts.SyntaxKind.ExpressionStatement) {
                    // we need to store register in stack to reuse it in next expression
                    this.functionContext.stack.push(leftOperandInfo);
                }
                this.functionContext.code.push([Ops.MOVE, leftOperandInfo.getRegister(), rightOperandInfo.getRegister()]);
            }
        } else if (leftOperandInfo.kind === ResolvedKind.Upvalue) {
            this.functionContext.code.push([
                Ops.SETUPVAL,
                rightOperandInfo.getRegister(),
                leftOperandInfo.getRegisterOrIndex()
            ]);
        } else {
            throw new Error('Not Implemented');
        }
    }

    private processDeleteExpression(node: ts.DeleteExpression): void {
        const assignNull = ts.createAssignment(node.expression, ts.createNull());
        assignNull.parent = node;
        this.processExpression(assignNull);
    }

    private processNewExpression(node: ts.NewExpression): void {

        // special cases: new Array and new Object
        if (node.expression.kind === ts.SyntaxKind.Identifier && (!node.arguments || node.arguments.length === 0)) {
            const name = node.expression.getText();
            if (name === 'Object') {
                return this.processObjectLiteralExpression(ts.createObjectLiteral());
            }

            if (name === 'Array') {
                return this.processArrayLiteralExpression(ts.createArrayLiteral());
            }

            if (name === 'String') {
                return this.processStringLiteral(ts.createStringLiteral(''));
            }
        }

        this.processExpression(
            ts.createObjectLiteral([
                ts.createPropertyAssignment('__proto', node.expression),
                ts.createPropertyAssignment('__index', node.expression)
            ]));
        const resultInfo = this.functionContext.stack.peek();

        this.processExpression(ts.createIdentifier('setmetatable'));
        const setmetatableInfo = this.functionContext.stack.peek();

        // call setmetatable(obj, obj)
        const param1Info = this.functionContext.useRegisterAndPush();
        this.functionContext.code.push([
            Ops.MOVE, param1Info.getRegister(), resultInfo.getRegisterOrIndex()
        ]);

        const param2Info = this.functionContext.useRegisterAndPush();
        this.functionContext.code.push([
            Ops.MOVE, param2Info.getRegister(), resultInfo.getRegisterOrIndex()
        ]);

        // call setmetatable
        this.functionContext.code.push([
            Ops.CALL, setmetatableInfo.getRegister(), 3, 1
        ]);

        // call cleanup
        this.functionContext.stack.pop();
        this.functionContext.stack.pop();
        this.functionContext.stack.pop();

        // call constructor
        const methodInfo = this.functionContext.useRegisterAndPush();
        this.functionContext.code.push([
            Ops.SELF,
            methodInfo.getRegister(),
            resultInfo.getRegister(),
            this.resolver.returnConst('constructor', this.functionContext).getRegisterOrIndex()]);

        // to reserve 'this' register
        this.functionContext.useRegisterAndPush();

        // in case of empty constructor we need to skip call
        this.functionContext.code.push([Ops.TEST, methodInfo.getRegister(), 0]);
        const jmpOp = [Ops.JMP, 0, 0];
        this.functionContext.code.push(jmpOp);
        const beforeBlock = this.functionContext.code.length;

        this.emitCallOfLoadedMethod(
            <ts.CallExpression><any>{ parent: node, 'arguments': node.arguments || [] },
            resultInfo,
            true);

        jmpOp[2] = this.functionContext.code.length - beforeBlock;
    }

    private processCallExpression(node: ts.CallExpression): void {

        this.resolver.methodCall = true;
        this.resolver.thisMethodCall = null;

        // special cases to cast to string or number
        let processed = false;
        if (node.expression.kind === ts.SyntaxKind.Identifier && node.arguments.length === 1) {
            const name = node.expression.kind === ts.SyntaxKind.Identifier ? (<ts.Identifier>node.expression).text : '';
            if (name === 'String' || name === 'Number') {
                this.processExpression(ts.createIdentifier('to' + name.toLowerCase()));
                processed = true;
            }
        }

        // default case
        if (!processed) {
            this.processExpression(node.expression);
        }

        const selfOpCodeResolveInfoForThis = this.resolver.thisMethodCall;
        this.resolver.methodCall = false;
        this.resolver.thisMethodCall = null;

        this.emitCallOfLoadedMethod(node, selfOpCodeResolveInfoForThis);
    }

    private isValueNotRequired(parent: ts.Node): boolean {
        if (!parent) {
            return true;
        }

        return parent.kind === ts.SyntaxKind.ExpressionStatement
            || parent.kind === ts.SyntaxKind.VoidExpression
            || parent.kind === ts.SyntaxKind.ClassDeclaration
            || parent.kind === ts.SyntaxKind.ImportDeclaration;
    }

    private emitCallOfLoadedMethod(node: ts.CallExpression, _thisForNew?: ResolvedInfo, constructorCall?: boolean) {
        node.arguments.forEach(a => {
            // pop method arguments
            this.processExpression(a);
        });
        node.arguments.forEach(a => {
            this.functionContext.stack.pop();
        });
        if (_thisForNew) {
            this.functionContext.stack.pop();
        }

        const methodResolvedInfo = this.functionContext.stack.pop();
        // TODO: temporary solution: if method called in Statement then it is not returning value
        const parent = node.parent;
        const noReturnCall = constructorCall || this.isValueNotRequired(parent);
        const isMethodArgumentCall = parent
            && (parent.kind === ts.SyntaxKind.CallExpression
                || parent.kind === ts.SyntaxKind.PropertyAccessExpression
                || parent.kind === ts.SyntaxKind.SpreadElement);
        const returnCount = noReturnCall ? 1 : isMethodArgumentCall ? 0 : 2;
        if (returnCount !== 1) {
            this.functionContext.useRegisterAndPush();
        }

        // parameters number
        let parametersNumber = node.arguments.length + 1 + (_thisForNew ? 1 : 0);
        if (node.arguments.some(a => a.kind === ts.SyntaxKind.SpreadElement)) {
            parametersNumber = 0;
        }

        this.functionContext.code.push(
            [
                Ops.CALL,
                methodResolvedInfo.getRegister(),
                parametersNumber,
                returnCount
            ]);
    }

    private processThisExpression(node: ts.ThisExpression): void {
        if (this.functionContext.thisInUpvalue) {
            const resolvedInfo = this.resolver.returnThisUpvalue(this.functionContext);

            const resultInfo = this.functionContext.useRegisterAndPush();
            resultInfo.originalInfo = resolvedInfo;
            this.functionContext.code.push([Ops.GETUPVAL, resultInfo.getRegister(), resolvedInfo.getRegisterOrIndex()]);
            return;
        }

        this.functionContext.stack.push(this.resolver.returnThis(this.functionContext));
    }

    private processSuperExpression(node: ts.SuperExpression): void {
        const propertyAccessThis = ts.createPropertyAccess(ts.createThis(), ts.createIdentifier('__proto'));
        const superExpression = ts.createPropertyAccess(propertyAccessThis, ts.createIdentifier('__proto'));
        propertyAccessThis.parent = superExpression;
        superExpression.parent = node.parent;
        if (node.parent.kind === ts.SyntaxKind.CallExpression) {
            // this is construction call
            const constructorCall = ts.createPropertyAccess(superExpression, ts.createIdentifier('constructor'));
            constructorCall.parent = node.parent;
            superExpression.parent = constructorCall;
            this.processExpression(constructorCall);
        } else {
            this.processExpression(superExpression);
        }
    }

    private processVoidExpression(node: ts.VoidExpression): void {
        // call expression
        this.processExpression(node.expression);
        this.functionContext.stack.pop();

        // convert it into null
        this.processExpression(ts.createIdentifier('undefined'));
    }

    private processNonNullExpression(node: ts.NonNullExpression): void {
        this.processExpression(node.expression);
    }

    private processAsExpression(node: ts.AsExpression): void {
        this.processExpression(node.expression);
    }

    private processSpreadElement(node: ts.SpreadElement): void {
        // load first element
        const zeroElementAccessExpression = ts.createElementAccess(node.expression, ts.createNumericLiteral('0'));
        zeroElementAccessExpression.parent = node;
        this.processExpression(zeroElementAccessExpression);

        const propertyAccessExpression = ts.createPropertyAccess(ts.createIdentifier('table'), ts.createIdentifier('unpack'));
        const spreadCall = ts.createCall(
            propertyAccessExpression,
            undefined,
            [node.expression]);
        spreadCall.parent = node;
        this.processExpression(spreadCall);

        // discard 1 element in stack
        const spreadInfo = this.functionContext.stack.pop();
        const zeroElementInfo = this.functionContext.stack.pop();

        // store result again
        this.functionContext.useRegisterAndPush();
    }

    private preprocessConstAndUpvalues(resolvedInfo: ResolvedInfo, resolvedInfo2: ResolvedInfo) {

        const can1 = resolvedInfo.canUseIndex();
        const can2 = resolvedInfo2 && resolvedInfo2.canUseIndex();
        if (can1 && !resolvedInfo2 || can1 && can2) {
            return;
        }

        let pops = 0;
        if (!resolvedInfo.canUseIndex()) {
            if (resolvedInfo.kind === ResolvedKind.Const) {
                const resultInfo = this.functionContext.useRegisterAndPush();
                resultInfo.originalInfo = resolvedInfo.originalInfo;
                this.functionContext.code.push([Ops.LOADK, resultInfo.getRegister(), resolvedInfo.getRegisterOrIndex()]);
                resolvedInfo = resultInfo;
                pops++;
            }
        }

        if (resolvedInfo2 && !resolvedInfo2.canUseIndex()) {
            if (resolvedInfo2.kind === ResolvedKind.Const) {
                const resultInfo = this.functionContext.useRegisterAndPush();
                resultInfo.originalInfo = resolvedInfo2.originalInfo;
                this.functionContext.code.push([Ops.LOADK, resultInfo.getRegister(), resolvedInfo2.getRegisterOrIndex()]);
                resolvedInfo = resolvedInfo2;
                pops++;
            }
        }

        if (pops > 0) {
            this.functionContext.stack.pop();
        }

        if (pops > 1) {
            this.functionContext.stack.pop();
        }

        throw new Error('Not Implemented');
    }

    private processIndentifier(node: ts.Identifier): void {
        const resolvedInfo = this.resolver.resolver(<ts.Identifier>node, this.functionContext);
        if (resolvedInfo.kind === ResolvedKind.Register) {
            const resultInfo = this.functionContext.useRegisterAndPush();
            resultInfo.originalInfo = resolvedInfo;
            this.functionContext.code.push([Ops.MOVE, resultInfo.getRegister(), resolvedInfo.getRegisterOrIndex()]);
            return;
        }

        if (resolvedInfo.kind === ResolvedKind.Upvalue) {
            const resultInfo = this.functionContext.useRegisterAndPush();
            resultInfo.originalInfo = resolvedInfo;
            this.functionContext.code.push([Ops.GETUPVAL, resultInfo.getRegister(), resolvedInfo.getRegisterOrIndex()]);
            return;
        }

        if (resolvedInfo.kind === ResolvedKind.Const) {
            if (resolvedInfo.value === null) {
                const resultInfoNull = this.functionContext.useRegisterAndPush();
                resultInfoNull.originalInfo = resolvedInfo;
                this.functionContext.code.push([Ops.LOADNIL, resultInfoNull.getRegister(), 1]);
                return;
            }

            const resultInfo = this.functionContext.useRegisterAndPush();
            resultInfo.originalInfo = resolvedInfo;
            this.functionContext.code.push([Ops.LOADK, resultInfo.getRegister(), resolvedInfo.getRegisterOrIndex()]);
            return;
        }

        if (resolvedInfo.kind === ResolvedKind.LoadGlobalMember) {
            const objectIdentifierInfo = resolvedInfo.objectInfo;
            const memberIdentifierInfo = resolvedInfo.memberInfo;
            memberIdentifierInfo.isTypeReference = resolvedInfo.isTypeReference;

            const resultInfo = this.functionContext.useRegisterAndPush();
            resultInfo.originalInfo = memberIdentifierInfo;

            this.preprocessConstAndUpvalues(objectIdentifierInfo, memberIdentifierInfo);

            this.functionContext.code.push(
                [Ops.GETTABUP,
                resultInfo.getRegister(),
                objectIdentifierInfo.getRegisterOrIndex(),
                memberIdentifierInfo.getRegisterOrIndex()]);
            return;
        }

        throw new Error('Not Implemeneted');
    }

    private processPropertyAccessExpression(node: ts.PropertyAccessExpression): void {
        this.processExpression(node.expression);

        // HACK: special case to support #len
        if ((<any>node.name).__len) {
            const expressionInfo = this.functionContext.stack.pop().optimize();
            const lenResultInfo = this.functionContext.useRegisterAndPush();
            this.functionContext.code.push(
                [Ops.LEN,
                lenResultInfo.getRegister(),
                expressionInfo.getRegisterOrIndex()]);
            return;
        }

        this.resolver.Scope.push(this.functionContext.stack.peek());
        this.processExpression(node.name);
        this.resolver.Scope.pop();

        // perform load
        // we can call collapseConst becasee member is name all the time which means it is const value
        const memberIdentifierInfo = this.functionContext.stack.pop().collapseConst().optimize();
        const objectIdentifierInfo = this.functionContext.stack.pop().optimize();

        let opCode = Ops.GETTABLE;

        const readOpCode = this.functionContext.code.latest;
        if (readOpCode && readOpCode[0] === Ops.GETUPVAL) {
            this.functionContext.code.pop();
            opCode = Ops.GETTABUP;
            objectIdentifierInfo.register = readOpCode[2];
        }

        const objectOriginalInfo = objectIdentifierInfo.originalInfo;
        const upvalueOrConst = objectOriginalInfo
            && (objectOriginalInfo.kind === ResolvedKind.Upvalue && objectOriginalInfo.identifierName === '_ENV'
                                /*|| objectOriginalInfo.kind === ResolvedKind.Const*/);

        // this.<...>(this support)
        if (this.resolver.methodCall
            && objectIdentifierInfo.kind === ResolvedKind.Register
            && !(objectIdentifierInfo.originalInfo && objectIdentifierInfo.originalInfo.isTypeReference)
            && !upvalueOrConst
            && node.parent
            && node.parent.kind === ts.SyntaxKind.CallExpression) {
            opCode = Ops.SELF;
        }

        const resultInfo = this.functionContext.useRegisterAndPush();
        this.functionContext.code.push(
            [opCode,
                resultInfo.getRegister(),
                objectIdentifierInfo.getRegisterOrIndex(),
                memberIdentifierInfo.getRegisterOrIndex()]);

        if (opCode === Ops.SELF) {
            this.resolver.thisMethodCall = this.functionContext.useRegisterAndPush();
        }
    }

    private emitGetOrCreateObjectExpression(node: ts.Node, globalVariableName: string) {
        const prototypeIdentifier = ts.createIdentifier(globalVariableName);
        const getOrCreateObjectExpr = ts.createAssignment(
            prototypeIdentifier,
            ts.createBinary(prototypeIdentifier, ts.SyntaxKind.BarBarToken, ts.createObjectLiteral()));
        getOrCreateObjectExpr.parent = node.parent;
        this.processExpression(getOrCreateObjectExpr);
    }

    private emitHeader(): void {
        // writing header
        // LUA_SIGNATURE
        this.writer.writeArray([0x1b, 0x4c, 0x75, 0x61]);
        // LUAC_VERSION, LUAC_FORMAT
        this.writer.writeArray([0x53, 0x00]);
        // LUAC_DATA: data to catch conversion errors
        this.writer.writeArray([0x19, 0x93, 0x0d, 0x0a, 0x1a, 0x0a]);
        // sizeof(int), sizeof(size_t), sizeof(Instruction), sizeof(lua_Integer), sizeof(lua_Number)
        this.writer.writeArray([0x04, 0x08, 0x04, 0x08, 0x08]);
        // LUAC_INT
        this.writer.writeArray([0x78, 0x56, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0]);
        // LUAC_NUM
        this.writer.writeArray([0x0, 0x0, 0x0, 0x0, 0x0, 0x28, 0x77, 0x40]);
    }

    private emitFunction(functionContext: FunctionContext): void {
        this.emitFunctionHeader(functionContext);
        this.emitFunctionCode(functionContext);
        this.emitConstants(functionContext);
        this.emitUpvalues(functionContext);
        this.emitProtos(functionContext);
        this.emitDebug(functionContext);
    }

    private emitFunctionHeader(functionContext: FunctionContext): void {
        // write debug info, by default 0 (string)
        this.writer.writeString(functionContext.debug_location || null);

        // f->linedefined = 0, (int)
        this.writer.writeInt(functionContext.linedefined || 0);

        // f->lastlinedefined = 0, (int)
        this.writer.writeInt(functionContext.lastlinedefined || 0);

        // f->numparams (byte)
        this.writer.writeByte(functionContext.numparams || 0);

        // f->is_vararg (byte)
        this.writer.writeByte(functionContext.is_vararg ? 1 : 0);

        // f->maxstacksize
        this.writer.writeByte(functionContext.maxstacksize + 1);
    }

    private emitFunctionCode(functionContext: FunctionContext): void {
        this.writer.writeInt(functionContext.code.length);

        functionContext.code.forEach(c => {
            // create 4 bytes value
            const opCodeMode: OpMode = OpCodes[c[0]];
            const encoded = opCodeMode.encode(c);
            this.writer.writeInt(encoded);
        });
    }

    private emitConstants(functionContext: FunctionContext): void {
        this.writer.writeInt(functionContext.constants.length);

        functionContext.constants.forEach(c => {

            if (c !== null) {
                // create 4 bytes value
                switch (typeof c) {
                    case 'boolean':
                        this.writer.writeByte(LuaTypes.LUA_TBOOLEAN);
                        this.writer.writeByte(c);
                        break;
                    case 'number':
                        if (Number.isInteger(c)) {
                            this.writer.writeByte(LuaTypes.LUA_TNUMINT);
                            this.writer.writeInteger(c);
                        } else {
                            this.writer.writeByte(LuaTypes.LUA_TNUMBER);
                            this.writer.writeNumber(c);
                        }
                        break;
                    case 'string':
                        if ((<string>c).length > 255) {
                            this.writer.writeByte(LuaTypes.LUA_TLNGSTR);
                        } else {
                            this.writer.writeByte(LuaTypes.LUA_TSTRING);
                        }

                        this.writer.writeString(c);
                        break;
                    default: throw new Error('Method not implemeneted');
                }
            } else {
                this.writer.writeByte(LuaTypes.LUA_TNIL);
            }
        });
    }

    private emitUpvalues(functionContext: FunctionContext): void {
        this.writer.writeInt(functionContext.upvalues.length);

        functionContext.upvalues.forEach((upvalue: UpvalueInfo, index: number) => {
            // in stack (bool)
            this.writer.writeByte((upvalue.instack) ? 1 : 0);
            // index
            this.writer.writeByte(upvalue.index !== undefined ? upvalue.index : index);
        });
    }

    private emitProtos(functionContext: FunctionContext): void {
        this.writer.writeInt(functionContext.protos.length);

        functionContext.protos.forEach(p => {
            // TODO: finish it
            this.emitFunction(p);
        });
    }

    private emitDebug(functionContext: FunctionContext): void {
        // line info
        this.writer.writeInt(functionContext.code.length);
        functionContext.code.forEach(c => {
            this.writer.writeInt(c[4]);
        });

        // local vars
        this.writer.writeInt(functionContext.locals.length);
        functionContext.locals.forEach(l => {
            this.writer.writeString(l.name);
            this.writer.writeInt(l.debugStartCode);
            this.writer.writeInt(l.debugEndCode);
        });

        // upvalues
        this.writer.writeInt(functionContext.upvalues.length);
        functionContext.upvalues.forEach(u => {
            this.writer.writeString(u.name);
        });
    }
}
