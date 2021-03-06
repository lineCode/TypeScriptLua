@call clean_bs.bat .\BABYLON
@call clean_bs.bat ..\..\thirdparty\Babylon.js\src

echo =
echo ==================================
echo Building Babylon.JS
echo ==================================
echo =
echo =

cd ..\..\thirdparty\Babylon.js\src
node ../../../__out/main.js -jslib -varAsLet

rmdir /S /Q  BABYLON
md BABYLON
echo =
echo ==================================
echo Copying binary Lua files for BabylonJS
echo ==================================
echo =
echo =

cd ..\..\..\experiments\BABYLON
xcopy /S ..\..\thirdparty\Babylon.js\src\*.lua .\BABYLON\
xcopy /S ..\..\thirdparty\Babylon.js\src\*.lua.map .\BABYLON\

cd
rmdir /S /Q Shaders
md Shaders
echo =
echo ==================================
echo Copying source for Shaders
echo ==================================
echo =
echo =

xcopy /S /Y ..\..\thirdparty\Babylon.js\src\Shaders .\Shaders\

@call copy_js.bat

echo =
echo ==================================
echo Building Babylon.JS Client
echo ==================================
echo =
echo =

node ../../__out/main.js -jslib -varAsLet
