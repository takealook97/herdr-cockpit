package main

import "os"

func main() { os.Exit(cmdHud(os.Args[1:], os.Stdout, os.Stderr)) }
